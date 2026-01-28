import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  DATA_DIR,
  FILE_NAMES,
  ensureDirectory,
  appendJsonLine,
  rotateJsonlIfNeeded,
} from "../lib/state.mjs";

const CODEX_EVENTS_FILE = path.join(DATA_DIR, FILE_NAMES.codex);
const PERF_LOG_PATH = path.join(os.homedir(), ".ai-perf.log");
const POLL_INTERVAL_MS = 2500;
const ROTATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let tailPosition = 0;

function tryParseNumber(value) {
  if (value === undefined || value === null) return value;
  const asNumber = Number(value);
  return Number.isNaN(asNumber) ? value : asNumber;
}

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const [measurement, ...restParts] = trimmed.split(",");
  const rest = restParts.join(",");
  const fields = {};

  const matches = rest.match(/([a-zA-Z0-9_]+)=([^\s,]+)/g) ?? [];
  for (const match of matches) {
    const [key, rawValue] = match.split("=");
    fields[key] = tryParseNumber(rawValue);
  }

  const remainingText = rest.replace(/([a-zA-Z0-9_]+=[^\s,]+)/g, "").trim();
  if (remainingText) {
    fields.note = remainingText;
  }

  return {
    measurement: measurement ?? "codex",
    ts: Date.now(),
    raw: trimmed,
    ...fields,
  };
}

async function readNewEntries() {
  try {
    const stat = await fs.stat(PERF_LOG_PATH);
    if (stat.size <= tailPosition) {
      return;
    }

    const handle = await fs.open(PERF_LOG_PATH, "r");
    const length = stat.size - tailPosition;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, tailPosition);
    await handle.close();

    tailPosition = stat.size;
    const chunk = buffer.toString("utf8");
    const lines = chunk.split(/\r?\n/);

    for (const line of lines) {
      const parsed = parseLine(line);
      if (!parsed) continue;
      await appendJsonLine(CODEX_EVENTS_FILE, parsed);
    }
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return;
    }
    console.error("[ai-dashboard] error reading Codex log:", error);
  }
}

async function waitForLogFile() {
  while (true) {
    try {
      await fs.access(PERF_LOG_PATH);
      return;
    } catch {
      console.log("[ai-dashboard] waiting for ~/.ai-perf.log ...");
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

async function startMonitor() {
  await ensureDirectory();

  if (!fsSync.existsSync(PERF_LOG_PATH)) {
    await waitForLogFile();
  }

  const stat = await fs.stat(PERF_LOG_PATH);
  tailPosition = stat.size;

  await readNewEntries();
  const interval = setInterval(readNewEntries, POLL_INTERVAL_MS);
  const rotationInterval = setInterval(
    () => rotateJsonlIfNeeded(CODEX_EVENTS_FILE, 500),
    ROTATION_INTERVAL_MS,
  );

  const watcher = fsSync.watch(
    path.dirname(PERF_LOG_PATH),
    (eventType, filename) => {
      if (filename === path.basename(PERF_LOG_PATH)) {
        readNewEntries().catch((error) => {
          console.error("[ai-dashboard] watcher failed:", error);
        });
      }
    },
  );

  process.on("SIGINT", () => {
    clearInterval(interval);
    clearInterval(rotationInterval);
    watcher.close();
    console.log("[ai-dashboard] Codex log monitor stopped");
    process.exit(0);
  });
}

startMonitor().catch((error) => {
  console.error("[ai-dashboard] Codex monitor failed to start:", error);
  process.exit(1);
});
