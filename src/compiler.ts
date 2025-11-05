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
import { stableHash } from "./utils/hashing.js";

const queue = new PQueue({ concurrency: 2 });

// Where source projects are created
const BASE_DIR = "/tmp/builds";

// Root cache dir on host (mounted). Each build gets its own subdir here.
const CARGO_TARGET_ROOT = "/mnt/cache/target";

export class AlkanesCompiler {
  private baseDir: string;
  private cleanupAfter: boolean;

  constructor(options?: { baseDir?: string; cleanup?: boolean }) {
    this.baseDir = options?.baseDir ?? BASE_DIR;
    this.cleanupAfter = options?.cleanup ?? true;
  }

  /** Deterministic build dir based on the contract source hash */
  private async getBuildDirForSource(sourceCode: string) {
    const hash = stableHash(sourceCode);
    const dir = path.join(this.baseDir, `build_${hash}`);
    await fs.mkdir(dir, { recursive: true });
    return { dir, hash };
  }

  /** Run `cargo build` with sccache, using an isolated per-hash target dir */
  private async runCargoBuild(
    tempDir: string,
    targetDir: string
  ): Promise<void> {
    await fs.mkdir(targetDir, { recursive: true });

    return new Promise<void>((resolve, reject) => {
      const cargo = spawn(
        "cargo",
        ["build", "--target=wasm32-unknown-unknown", "--release"],
        {
          cwd: tempDir,
          env: {
            ...process.env,
            RUSTC_WRAPPER: "/usr/local/cargo/bin/sccache",
            SCCACHE_DIR: "/mnt/cache/sccache",
            CARGO_TARGET_DIR: targetDir, // per-hash, prevents races while still hot via sccache
          },
        }
      );

      cargo.stdout.on("data", (data) => {
        logger.info({ event: "cargo:stdout", message: data.toString().trim() });
      });

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
    const { dir: tempDir, hash } = await this.getBuildDirForSource(sourceCode);
    const targetDir = path.join(CARGO_TARGET_ROOT, `build_${hash}`);

    try {
      logger.info({ event: "compile:prepare", tempDir, targetDir, hash });

      await this.createProject(tempDir, sourceCode);

      logger.info({ event: "compile:cargo_start", tempDir, targetDir });
      await this.runCargoBuild(tempDir, targetDir);
      logger.info({ event: "compile:cargo_done" });

      // Expect a fixed crate name. Ensure your cargoTemplate sets:
      // [package] name = "alkanes_contract"
      // [lib] crate-type = ["cdylib"]
      const wasmPath = path.join(
        targetDir,
        "wasm32-unknown-unknown",
        "release",
        "alkanes_contract.wasm"
      );

      const wasmBuffer = await fs.readFile(wasmPath);
      const abi = await this.parseABI(sourceCode);

      return { wasmBuffer, abi };
    } finally {
      if (this.cleanupAfter) {
        // We keep targetDir (cache) but remove the small source dir to save space
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  private async createProject(tempDir: string, sourceCode: string) {
    await fs.mkdir(tempDir, { recursive: true });
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "Cargo.toml"), cargoTemplate);
    await fs.writeFile(path.join(tempDir, "src", "lib.rs"), sourceCode);
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

      methods.push({
        opcode: opcodeNum,
        name: variantName,
        inputs,
        outputs,
      });
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
