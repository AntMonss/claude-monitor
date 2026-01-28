import express from "express";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  DATA_DIR,
  FILE_NAMES,
  ensureDirectory,
  readWatchingState,
  writeWatchingState,
  readJsonLines,
  rotateJsonlIfNeeded,
} from "./lib/state.mjs";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/api/state", async (req, res) => {
  const state = await readWatchingState();
  res.json(state);
});

app.post("/api/state", async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled flag must be boolean" });
  }
  const state = await writeWatchingState(enabled);
  void ensureManagedProcesses(enabled);
  res.json(state);
});

app.get("/api/events", async (req, res) => {
  const limit = Math.max(5, Math.min(Number(req.query.limit) || 60, 200));
  const [systemMetrics, processStats, codexEvents, latencyEvents, claudeEvents] = await Promise.all([
    readJsonLines(FILE_NAMES.system, limit),
    readJsonLines(FILE_NAMES.process, limit),
    readJsonLines(FILE_NAMES.codex, limit),
    readJsonLines(FILE_NAMES.latency, limit),
    readJsonLines(FILE_NAMES.claude, limit),
  ]);
  res.json({ systemMetrics, processStats, codexEvents, latencyEvents, claudeEvents });
});

// Periodic rotation of JSONL files (every 5 minutes)
setInterval(async () => {
  const files = [FILE_NAMES.system, FILE_NAMES.process, FILE_NAMES.codex, FILE_NAMES.latency, FILE_NAMES.claude];
  for (const file of files) {
    await rotateJsonlIfNeeded(path.join(DATA_DIR, file), 500);
  }
}, 5 * 60 * 1000);

const distPath = path.resolve("dist");
app.use(express.static(distPath));

app.get("*", async (req, res, next) => {
  try {
    const fs = await import("node:fs/promises");
    const html = await fs.readFile(path.join(distPath, "index.html"), "utf8");
    return res.type("html").send(html);
  } catch (error) {
    next();
  }
});

const port = Number(process.env.PORT ?? 3121);
app.listen(port, () => {
  console.log(`[ai-dashboard] server listening on http://localhost:${port}`);
});

const MANAGED_COMMANDS = [
  { name: "collector", script: "collector" },
  { name: "codex-log", script: "codex-log" },
  { name: "latency", script: "latency" },
  { name: "otel-collector", script: "otel-collector" },
];

const managedProcesses = new Map();

async function ensureManagedProcesses(enabled) {
  if (enabled) {
    for (const { name, script } of MANAGED_COMMANDS) {
      if (managedProcesses.has(name)) {
        continue;
      }
      const child = spawn("npm", ["run", script], {
        cwd: process.cwd(),
        shell: true,
        stdio: ["ignore", "inherit", "inherit"],
        env: process.env,
      });
      managedProcesses.set(name, child);
      child.on("exit", () => {
        managedProcesses.delete(name);
      });
    }
  } else {
    for (const child of managedProcesses.values()) {
      child.kill("SIGINT");
    }
    managedProcesses.clear();
  }
}

async function initManagedProcesses() {
  await ensureDirectory();
  const state = await readWatchingState();
  if (state.enabled) {
    await ensureManagedProcesses(true);
  }
}

process.on("SIGINT", () => {
  ensureManagedProcesses(false).then(() => process.exit(0));
});

initManagedProcesses();
