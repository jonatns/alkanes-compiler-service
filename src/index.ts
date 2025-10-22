import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import { compileContract } from "./compiler.js";
import { logger } from "./utils/logger.js";
import crypto from "crypto";

const PORT = Number(process.env.PORT) || 8080;
const HOST = "0.0.0.0";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, timestamp: Date.now() });
});

app.post("/compile", async (req: Request, res: Response) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.API_KEY}`) {
    logger.warn({ event: "unauthorized", ip: req.ip });
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { code, contractName } = req.body;
    if (!code || typeof code !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'code'" });
    }

    const result = await compileContract(contractName || "MyContract", code);

    res.json({
      success: true,
      wasm: result?.wasmBuffer.toString("base64"),
      abi: result?.abi,
    });
  } catch (err) {
    const errorId = crypto.randomUUID();
    logger.error({ event: "compile:error", errorId, err });

    res.status(500).json({
      success: false,
      error: "Compilation failed",
      errorId,
    });
  }
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const errorId = crypto.randomUUID();
  logger.error({ event: "unhandled:error", errorId, err });
  res.status(500).json({ error: "Internal Server Error", errorId });
});

const server = app.listen(PORT, HOST, () => {
  logger.info(`🚀 Alkanes compiler service running on http://${HOST}:${PORT}`);
});

const shutdown = (signal: string) => {
  logger.info({ event: "shutdown", signal }, "Shutting down gracefully...");
  server.close(() => {
    logger.info("✅ HTTP server closed.");
    process.exit(0);
  });
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  logger.error({ event: "uncaughtException", err });
});
process.on("unhandledRejection", (reason) => {
  logger.error({ event: "unhandledRejection", reason });
});
