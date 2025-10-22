import { AlkanesCompiler } from "@jonatns/labcoat";
import PQueue from "p-queue";
import { logger } from "./utils/logger.js";

const queue = new PQueue({ concurrency: 2 });

export async function compileContract(contractName: string, code: string) {
  return queue.add(async () => {
    const start = Date.now();
    const compiler = new AlkanesCompiler({ baseDir: "/mnt/builds" });

    logger.info({
      event: "compile:start",
      contract: contractName,
      codeLength: code.length,
      baseDir: "/tmp",
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
