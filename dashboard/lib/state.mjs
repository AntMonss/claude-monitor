import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const DATA_DIR = path.resolve("temp", "ai-dashboard");
export const STATE_FILE = path.join(DATA_DIR, "watching-state.json");

export const FILE_NAMES = {
  system: "system-metrics.jsonl",
  process: "process-stats.jsonl",
  codex: "codex-events.jsonl",
  codexLocal: "codex-local-events.jsonl",
  latency: "latency-events.jsonl",
  claude: "claude-otel-events.jsonl",
  claudeLocal: "claude-local-events.jsonl",
};

// Claude Code local paths
export const CLAUDE_HOME = path.join(os.homedir(), ".claude");
export const CLAUDE_PATHS = {
  history: path.join(CLAUDE_HOME, "history.jsonl"),
  statsCache: path.join(CLAUDE_HOME, "stats-cache.json"),
  telemetry: path.join(CLAUDE_HOME, "telemetry"),
  tasks: path.join(CLAUDE_HOME, "tasks"),
  projects: path.join(CLAUDE_HOME, "projects"),
};

// Codex local paths
export const CODEX_HOME = path.join(os.homedir(), ".codex");
export const CODEX_PATHS = {
  history: path.join(CODEX_HOME, "history.jsonl"),
  sessions: path.join(CODEX_HOME, "sessions"),
  config: path.join(CODEX_HOME, "config.toml"),
  log: path.join(CODEX_HOME, "log"),
};

export async function ensureDirectory() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

export async function readWatchingState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : true,
      updatedAt: parsed.updatedAt ?? Date.now(),
    };
  } catch {
    return { enabled: true, updatedAt: Date.now() };
  }
}

export async function writeWatchingState(enabled) {
  await ensureDirectory();
  const payload = { enabled, updatedAt: Date.now() };
  await fs.writeFile(STATE_FILE, JSON.stringify(payload) + "\n");
  return payload;
}

export async function appendJsonLine(file, payload) {
  await fs.appendFile(file, JSON.stringify(payload) + "\n");
}

/**
 * Rotate a JSONL file, keeping only the last `maxLines` entries.
 */
export async function rotateJsonlIfNeeded(filePath, maxLines = 500) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length > maxLines) {
      const trimmed = lines.slice(-maxLines);
      await fs.writeFile(filePath, trimmed.join("\n") + "\n");
      console.log(`[ai-dashboard] rotated ${filePath}: ${lines.length} → ${trimmed.length} lines`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error(`[ai-dashboard] rotation error for ${filePath}:`, error);
    }
  }
}

export async function readJsonLines(fileName, limit) {
  const filePath = path.join(DATA_DIR, fileName);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .slice(-limit);
    return lines.map((line) => JSON.parse(line));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
