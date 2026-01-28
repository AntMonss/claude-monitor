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

// OTEL collector health check port
const OTEL_PORT = 4319;

/**
 * Check if OTEL collector is receiving active telemetry
 * Returns true if OTEL is up and has recent events
 */
async function checkOtelStatus() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const res = await fetch(`http://localhost:${OTEL_PORT}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return false;

    // Also check if we have recent OTEL events (last 5 minutes)
    const claudeEvents = await readJsonLines(FILE_NAMES.claude, 10);
    if (claudeEvents.length === 0) return false;

    const latestTs = claudeEvents[claudeEvents.length - 1]?.ts;
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

    return latestTs > fiveMinutesAgo;
  } catch {
    return false;
  }
}

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
  const [systemMetrics, processStats, codexEvents, codexLocalEvents, latencyEvents, claudeEvents, claudeLocalEvents, otelUp] = await Promise.all([
    readJsonLines(FILE_NAMES.system, limit),
    readJsonLines(FILE_NAMES.process, limit),
    readJsonLines(FILE_NAMES.codex, limit),
    readJsonLines(FILE_NAMES.codexLocal, limit),
    readJsonLines(FILE_NAMES.latency, limit),
    readJsonLines(FILE_NAMES.claude, limit),
    readJsonLines(FILE_NAMES.claudeLocal, limit),
    checkOtelStatus(),
  ]);

  // Determine monitoring mode based on OTEL status
  const mode = otelUp ? "active" : "passive";

  res.json({
    systemMetrics,
    processStats,
    codexEvents,
    codexLocalEvents,
    latencyEvents,
    claudeEvents,
    claudeLocalEvents,
    mode,
  });
});

// Mode endpoint for quick mode check
app.get("/api/mode", async (req, res) => {
  const otelUp = await checkOtelStatus();
  res.json({ mode: otelUp ? "active" : "passive", otelUp });
});

// Periodic rotation of JSONL files (every 5 minutes)
setInterval(async () => {
  const files = [FILE_NAMES.system, FILE_NAMES.process, FILE_NAMES.codex, FILE_NAMES.codexLocal, FILE_NAMES.latency, FILE_NAMES.claude, FILE_NAMES.claudeLocal];
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
  { name: "claude-local", script: "claude-local" },
  { name: "codex-local", script: "codex-local" },
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
