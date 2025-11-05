import PQueue from "p-queue";
import { logger } from "./utils/logger.js";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import {
  AlkanesABI,
  AlkanesInput,
  AlkanesMethod,
  StorageKey,
} from "./types.js";
import { cargoTemplate } from "./templates.js";

const queue = new PQueue({ concurrency: 2 });

const BASE_DIR = "/tmp/builds";
const ARTIFACTS_DIR = "/mnt/cache/artifacts";
const CARGO_CACHE_DIR = "/mnt/cache/target";

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
}

function stableHash(source: string): string {
  const normalized = source
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim();

  return crypto
    .createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 12);
}

// --- Global in-memory build lock registry ---
const buildLocks = new Map<string, Promise<any>>();

async function withBuildLock<T>(
  hash: string,
  fn: () => Promise<T>
): Promise<T> {
  if (buildLocks.has(hash)) {
    logger.info({ event: "build:dedup", hash });
    return await buildLocks.get(hash)!;
  }

  const promise = fn().finally(() => buildLocks.delete(hash));
  buildLocks.set(hash, promise);
  return await promise;
}

export class AlkanesCompiler {
  private baseDir: string;
  private cleanupAfter: boolean;

  constructor(options?: { baseDir?: string; cleanup?: boolean }) {
    this.baseDir = options?.baseDir ?? BASE_DIR;
    this.cleanupAfter = options?.cleanup ?? true;
  }

  private async getBuildDir(sourceCode: string) {
    const hash = stableHash(sourceCode);
    const dir = path.join(this.baseDir, `build_${hash}`);
    await ensureDir(dir);
    return { dir, hash };
  }

  private async runCargoBuild(
    tempDir: string,
    extraEnv: Record<string, string> = {}
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cargo = spawn(
        "cargo",
        ["build", "--target=wasm32-unknown-unknown", "--release"],
        {
          cwd: tempDir,
          env: { ...process.env, ...extraEnv },
        }
      );

      cargo.stdout.on("data", (data) =>
        logger.info({ event: "cargo:stdout", message: data.toString().trim() })
      );

      cargo.stderr.on("data", (data) => {
        const text = data.toString().trim();
        const isRealError = /error(\[E\d+\])?:/i.test(text);
        logger[isRealError ? "error" : "info"]({
          event: "cargo:stderr",
          message: text,
        });
      });

      cargo.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Cargo build failed with code ${code}`));
      });
    });
  }

  async compile(
    contractName: string,
    sourceCode: string
  ): Promise<{ wasmBuffer: Buffer; abi: AlkanesABI }> {
    const { dir: tempDir, hash } = await this.getBuildDir(sourceCode);
    await ensureDir(ARTIFACTS_DIR);

    const wasmOut = path.join(ARTIFACTS_DIR, `${hash}.wasm`);
    const abiOut = path.join(ARTIFACTS_DIR, `${hash}.abi.json`);

    // 🔁 Reuse cached artifacts if they exist
    if (await this.fileExists(wasmOut)) {
      logger.info({ event: "compile:cache_hit", hash });
      const wasmBuffer = await fs.readFile(wasmOut);
      const abi = JSON.parse(await fs.readFile(abiOut, "utf8"));
      return { wasmBuffer, abi };
    }

    return await withBuildLock(hash, async () => {
      // Check again inside lock (another builder may have finished)
      if (await this.fileExists(wasmOut)) {
        logger.info({ event: "compile:cache_hit_after_lock", hash });
        const wasmBuffer = await fs.readFile(wasmOut);
        const abi = JSON.parse(await fs.readFile(abiOut, "utf8"));
        return { wasmBuffer, abi };
      }

      logger.info({ event: "compile:start_build", hash, tempDir });
      await this.createProject(tempDir, sourceCode);

      await this.runCargoBuild(tempDir, {
        CARGO_TARGET_DIR: CARGO_CACHE_DIR,
        RUSTC_WRAPPER: "/usr/local/cargo/bin/sccache",
      });

      const wasmPath = path.join(
        tempDir,
        "target",
        "wasm32-unknown-unknown",
        "release",
        "alkanes_contract.wasm"
      );

      const wasmBuffer = await fs.readFile(wasmPath);
      const abi = await this.parseABI(sourceCode);

      await fs.writeFile(wasmOut, wasmBuffer);
      await fs.writeFile(abiOut, JSON.stringify(abi, null, 2));

      logger.info({ event: "compile:done", hash, wasmSize: wasmBuffer.length });

      if (this.cleanupAfter) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }

      return { wasmBuffer, abi };
    });
  }

  private async createProject(tempDir: string, sourceCode: string) {
    await ensureDir(path.join(tempDir, "src"));
    await fs.writeFile(path.join(tempDir, "Cargo.toml"), cargoTemplate);
    await fs.writeFile(path.join(tempDir, "src", "lib.rs"), sourceCode);
  }

  private async fileExists(p: string) {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  public async parseABI(sourceCode: string): Promise<AlkanesABI> {
    const methods: AlkanesMethod[] = [];
    const opcodes: Record<string, number> = {};

    const messageRegex =
      /#\[opcode\((\d+)\)\](?:\s*#\[returns\(([^)]+)\)\])?\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\{([^}]*)\})?/gm;

    let match: RegExpExecArray | null;
    while ((match = messageRegex.exec(sourceCode)) !== null) {
      const [, opcodeStr, returnsType, variantName, inputBlock] = match;
      const opcodeNum = parseInt(opcodeStr, 10);
      const outputs = returnsType ? [returnsType.trim()] : [];

      const inputs: AlkanesInput[] = [];
      if (inputBlock && inputBlock.trim().length > 0) {
        const fieldRegex = /(\w+)\s*:\s*([\w<>]+)/g;
        let fieldMatch: RegExpExecArray | null;
        while ((fieldMatch = fieldRegex.exec(inputBlock)) !== null) {
          const [, fieldName, fieldType] = fieldMatch;
          inputs.push({ name: fieldName.trim(), type: fieldType.trim() });
        }
      }

      methods.push({ opcode: opcodeNum, name: variantName, inputs, outputs });
      opcodes[variantName] = opcodeNum;
    }

    const structRegex = /pub\s+struct\s+(\w+)/g;
    const structNames: string[] = [];
    let structMatch: RegExpExecArray | null;
    while ((structMatch = structRegex.exec(sourceCode)) !== null) {
      structNames.push(structMatch[1]);
    }

    const name = structNames.length > 0 ? structNames[0] : "UnknownContract";

    const storage: StorageKey[] = [];
    const storageRegex = /StoragePointer::from_keyword\("([^"]+)"\)/g;
    let storageMatch: RegExpExecArray | null;
    while ((storageMatch = storageRegex.exec(sourceCode)) !== null) {
      storage.push({ key: storageMatch[1], type: "Vec<u8>" });
    }

    return { name, version: "1.0.0", methods, storage, opcodes };
  }
}

export async function compileContract(contractName: string, code: string) {
  return queue.add(async () => {
    const start = Date.now();
    const compiler = new AlkanesCompiler({ baseDir: BASE_DIR });

    logger.info({
      event: "compile:start",
      contract: contractName,
      codeLength: code.length,
      baseDir: BASE_DIR,
    });

    try {
      const result = await compiler.compile(contractName, code);
      const duration = ((Date.now() - start) / 1000).toFixed(2);
      logger.info({
        event: "compile:success",
        contract: contractName,
        durationSeconds: duration,
        wasmSize: result?.wasmBuffer?.length || 0,
      });
      return result;
    } catch (err: any) {
      const duration = ((Date.now() - start) / 1000).toFixed(2);
      logger.error({
        event: "compile:error",
        contract: contractName,
        durationSeconds: duration,
        message: err?.message,
        stack: err?.stack,
      });
      throw new Error(`Compilation failed: ${err?.message}`);
    }
  });
}
