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

// Diagnostic endpoint - calls Claude CLI for deep analysis
app.post("/api/diagnostic", async (req, res) => {
  const { diagnosticData } = req.body;

  if (!diagnosticData) {
    return res.status(400).json({ success: false, error: "Missing diagnosticData" });
  }

  const prompt = buildDiagnosticPrompt(diagnosticData);

  try {
    const result = await runClaudeAnalysis(prompt);
    res.json({ success: true, analysis: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

function buildDiagnosticPrompt(data) {
  const processLines = data.topProcesses?.map(p => {
    const cpu = p.avgCpu?.toFixed(1) ?? p.cpu ?? "?";
    const mem = p.mem?.toFixed(0) ?? "—";
    return "- " + p.name + ": " + cpu + "% CPU, " + mem + "MB RAM";
  }).join("\n") || "Aucun";

  const patternLines = data.patterns?.length > 0
    ? data.patterns.map(p => "- " + p.name + ": " + p.severity).join("\n")
    : "Aucun";

  const claudeLatency = data.claudeApiLatencyMs
    ? Math.round(data.claudeApiLatencyMs) + "ms"
    : "Pas de données OTEL";

  const claudeAvg = data.claudeApiAvgMs
    ? Math.round(data.claudeApiAvgMs) + "ms"
    : "N/A";

  return `Tu es un expert en diagnostic système. Analyse ces données et explique simplement ce qui pourrait causer des lenteurs ou problèmes. Sois concis et actionnable.

## Données système

CPU: ${data.cpu?.toFixed?.(1) ?? data.cpu}%
RAM: ${data.memory?.toFixed?.(0) ?? data.memory}% (${data.memoryUsedGb}GB / ${data.memoryTotalGb}GB)
Swap: ${data.swapGb}GB
Réseau: ↓ ${data.networkDown || "N/A"} · ↑ ${data.networkUp || "N/A"}

## API Claude (latence réelle via OTEL)
- Dernière requête: ${claudeLatency}
- Moyenne: ${claudeAvg}

## Session Claude Code
- Durée: ${data.sessionDuration} minutes
- Messages: ${data.messageCount}
- Ratio Message/Tool: ${data.messageToolRatio}

## Processus les plus gourmands
${processLines}

## Patterns détectés
${patternLines}

## Ta mission
1. Identifie LA cause la plus probable du problème (s'il y en a un)
2. Explique simplement pourquoi
3. Donne UNE action concrète à faire

Réponds en français, de façon simple et directe.`;
}

async function runClaudeAnalysis(prompt) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", "--", prompt];

    const claude = spawn("claude", args, {
      stdio: ["inherit", "pipe", "pipe"],
      cwd: process.cwd(),
    });

    let stdout = "";
    let stderr = "";

    claude.stdout.on("data", (data) => { stdout += data.toString(); });
    claude.stderr.on("data", (data) => { stderr += data.toString(); });

    // Timeout after 60 seconds
    const timeout = setTimeout(() => {
      claude.kill();
      reject(new Error("Timeout: Claude n'a pas répondu en 60s"));
    }, 60000);

    claude.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        try {
          const result = JSON.parse(stdout);
          resolve(result.result || stdout);
        } catch {
          resolve(stdout);
        }
      } else {
        reject(new Error(`Claude exited with code ${code}: ${stderr}`));
      }
    });

    claude.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start Claude CLI: ${err.message}. Is claude installed?`));
    });
  });
}

// Task management endpoints
const CLAUDE_TASKS_DIR = path.join(process.env.HOME || "", ".claude", "tasks");

// Open terminal with Claude Code to manage tasks
app.post("/api/tasks/open-terminal", async (req, res) => {
  try {
    // Use AppleScript to open Terminal with claude command
    const script = `
      tell application "Terminal"
        activate
        do script "cd ~ && claude --resume"
      end tell
    `;
    spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Clear OLD tasks from ~/.claude/tasks/ (>7 days old only)
app.post("/api/tasks/clear", async (req, res) => {
  try {
    const fs = await import("node:fs/promises");

    // Check if directory exists
    try {
      await fs.access(CLAUDE_TASKS_DIR);
    } catch {
      return res.json({ success: true, message: "No tasks directory", cleared: 0 });
    }

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let cleared = 0;
    let preserved = 0;

    // Only remove OLD subdirectories (>7 days)
    const entries = await fs.readdir(CLAUDE_TASKS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dirPath = path.join(CLAUDE_TASKS_DIR, entry.name);
        try {
          const stat = await fs.stat(dirPath);
          if (stat.mtimeMs < sevenDaysAgo) {
            await fs.rm(dirPath, { recursive: true, force: true });
            cleared++;
          } else {
            preserved++;
          }
        } catch {
          // Skip if can't stat
        }
      }
    }

    res.json({
      success: true,
      message: `Cleared ${cleared} old task directories, preserved ${preserved} recent ones`,
      cleared,
      preserved
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete a specific task
app.post("/api/tasks/delete", async (req, res) => {
  try {
    const fs = await import("node:fs/promises");
    const { taskId, taskDir } = req.body;

    if (!taskId) {
      return res.status(400).json({ success: false, error: "Missing taskId" });
    }

    // If taskDir is provided, delete just that task file
    if (taskDir) {
      const taskFile = path.join(CLAUDE_TASKS_DIR, taskDir, `${taskId}.json`);
      try {
        await fs.unlink(taskFile);
        return res.json({ success: true, message: `Deleted task ${taskId}` });
      } catch (err) {
        if (err.code === "ENOENT") {
          return res.json({ success: true, message: "Task file not found (already deleted?)" });
        }
        throw err;
      }
    }

    // Otherwise, search for the task in all directories
    const entries = await fs.readdir(CLAUDE_TASKS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const taskFile = path.join(CLAUDE_TASKS_DIR, entry.name, `${taskId}.json`);
        try {
          await fs.unlink(taskFile);
          return res.json({ success: true, message: `Deleted task ${taskId} from ${entry.name}` });
        } catch {
          // Task not in this directory, continue
        }
      }
    }

    res.json({ success: true, message: "Task not found" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
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
