import express from "express";
import cors from "cors";
import morgan from "morgan";
import { exec } from "child_process";
import { writeFile, mkdir, readFile, rm } from "fs/promises";
import { promisify } from "util";
import { join } from "path";
import crypto from "crypto";

const execAsync = promisify(exec);
const app = express();

const DEBUG = true;

// Keep a pool of pre-created project directories
const PROJECT_POOL_SIZE = 5;
const projectPool = new Set();

async function createProjectDir() {
  const projectId = crypto.randomBytes(16).toString("hex");
  const projectPath = join("/tmp", projectId);

  await mkdir(join(projectPath, "src"), { recursive: true });
  await writeFile(
    join(projectPath, "Cargo.toml"),
    await readFile("./templates/Cargo.toml")
  );

  projectPool.add(projectPath);
  if (DEBUG) {
    console.log(`Created project directory: ${projectPath}`);
  }
  return projectPath;
}

async function replenishPool() {
  while (projectPool.size < PROJECT_POOL_SIZE) {
    await createProjectDir();
  }
}

// Initial pool creation
replenishPool();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan(DEBUG ? "dev" : "tiny"));

app.post("/compile", async (req, res) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: "No Rust code provided" });
  }

  let projectPath;
  for (const path of projectPool) {
    projectPool.delete(path);
    projectPath = path;
    break;
  }

  if (!projectPath) {
    projectPath = await createProjectDir();
  }

  if (DEBUG) {
    console.log(`\nCompiling in directory: ${projectPath}`);
    console.log("Code length:", code.length, "bytes");
  }

  try {
    // Write source code
    await writeFile(join(projectPath, "src", "lib.rs"), code);
    if (DEBUG) {
      console.log("Source code written successfully");
    }

    // Use different cargo commands based on debug mode
    const cargoCommand = DEBUG
      ? "RUST_BACKTRACE=1 cargo build -v --target wasm32-unknown-unknown --release"
      : "cargo build --target wasm32-unknown-unknown --release";

    if (DEBUG) {
      console.log(`Executing: ${cargoCommand}`);
    }

    // Compile
    const { stdout, stderr } = await execAsync(cargoCommand, {
      cwd: projectPath,
      timeout: 30000, // 30 second timeout
    });

    // Read the WASM file
    const wasmPath = join(
      projectPath,
      "target/wasm32-unknown-unknown/release/alkanes_contract.wasm"
    );
    const wasmBuffer = await readFile(wasmPath);

    if (DEBUG) {
      console.log(`\nCompilation successful!`);
      console.log(`WASM size: ${wasmBuffer.length} bytes`);
      console.log("\nCompiler stdout:", stdout);
      console.log("\nCompiler stderr:", stderr);
    }

    // Clean up src directory but keep project structure for reuse
    await writeFile(join(projectPath, "src", "lib.rs"), "");
    projectPool.add(projectPath);
    replenishPool();

    res.json({
      success: true,
      wasm: wasmBuffer.toString("base64"),
      size: wasmBuffer.length,
      stdout: DEBUG ? stdout : undefined,
      stderr: DEBUG ? stderr : undefined,
      debug: DEBUG
        ? {
            projectPath,
            compilationCommand: cargoCommand,
            timestamp: new Date().toISOString(),
          }
        : undefined,
    });
  } catch (error) {
    console.error("Compilation error:", error);

    if (DEBUG) {
      console.error("\nFull error details:", {
        message: error.message,
        stdout: error.stdout,
        stderr: error.stderr,
        code: error.code,
        projectPath,
      });
    }

    // On error, destroy and recreate the project directory
    await rm(projectPath, { recursive: true, force: true });
    createProjectDir();

    res.status(500).json({
      success: false,
      error: error.message,
      stdout: DEBUG ? error.stdout : undefined,
      stderr: DEBUG ? error.stderr : undefined,
      debug: DEBUG
        ? {
            projectPath,
            errorCode: error.code,
            errorStack: error.stack,
            timestamp: new Date().toISOString(),
          }
        : undefined,
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Compiler server running on port ${port} (DEBUG: ${DEBUG})`);
});
