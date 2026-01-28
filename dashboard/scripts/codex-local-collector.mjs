/**
 * Codex Local Collector
 *
 * Reads local Codex files (~/.codex/) and generates events for passive monitoring.
 * Runs every 30 seconds to minimize I/O impact.
 *
 * Data sources:
 * - ~/.codex/history.jsonl - User prompts history
 * - ~/.codex/sessions/ - Session transcripts (YYYY/MM/DD/*.jsonl)
 *
 * Pattern detection thresholds:
 * - Message frequency: > 50/hour warning, > 100/hour error
 * - Session Duration: > 2h warning, > 4h error
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DATA_DIR,
  FILE_NAMES,
  CODEX_PATHS,
  ensureDirectory,
  appendJsonLine,
  rotateJsonlIfNeeded,
} from "../lib/state.mjs";

const CODEX_LOCAL_FILE = path.join(DATA_DIR, FILE_NAMES.codexLocal);
const POLL_INTERVAL_MS = 30_000; // 30 seconds
const ROTATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Pattern detection thresholds
const THRESHOLDS = {
  messagesPerHour: { warning: 50, error: 100 },
  sessionDurationMinutes: { warning: 120, error: 240 }, // 2h, 4h
};

/**
 * Read history.jsonl for recent prompts
 */
async function readHistory() {
  try {
    const raw = await fs.readFile(CODEX_PATHS.history, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    // Group by session
    const sessions = new Map();

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (!entry.session_id) continue;

        // ts is in seconds in Codex
        const tsMs = entry.ts * 1000;
        if (tsMs < oneDayAgo) continue;

        const session = sessions.get(entry.session_id) || {
          sessionId: entry.session_id,
          firstTs: tsMs,
          lastTs: tsMs,
          promptCount: 0,
          prompts: [],
        };

        session.promptCount++;
        if (tsMs < session.firstTs) session.firstTs = tsMs;
        if (tsMs > session.lastTs) session.lastTs = tsMs;
        session.prompts.push(entry.text?.slice(0, 50));

        sessions.set(entry.session_id, session);
      } catch {
        // Skip malformed lines
      }
    }

    return Array.from(sessions.values());
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("[codex-local] Error reading history:", error.message);
    }
    return [];
  }
}

/**
 * Find recent session files
 */
async function findRecentSessions() {
  const sessions = [];
  const now = new Date();

  // Check last 7 days
  for (let daysAgo = 0; daysAgo < 7; daysAgo++) {
    const date = new Date(now);
    date.setDate(date.getDate() - daysAgo);

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    const dayDir = path.join(CODEX_PATHS.sessions, String(year), month, day);

    try {
      const files = await fs.readdir(dayDir);
      for (const file of files.filter((f) => f.endsWith(".jsonl")).slice(0, 5)) {
        const filePath = path.join(dayDir, file);
        try {
          const stat = await fs.stat(filePath);
          sessions.push({
            path: filePath,
            name: file,
            mtime: stat.mtimeMs,
            date: `${year}-${month}-${day}`,
          });
        } catch {
          // Skip inaccessible files
        }
      }
    } catch {
      // Directory doesn't exist for this day
    }
  }

  // Sort by mtime, most recent first
  return sessions.sort((a, b) => b.mtime - a.mtime).slice(0, 10);
}

/**
 * Parse a session file for metadata
 */
async function parseSessionFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());

    let meta = null;
    let messageCount = 0;
    let toolCount = 0;
    let model = null;

    for (const line of lines.slice(0, 100)) {
      // Limit parsing
      try {
        const entry = JSON.parse(line);

        if (entry.type === "session_meta") {
          meta = entry.payload;
          model = meta?.model_provider;
        } else if (entry.type === "user_message" || entry.type === "assistant_message") {
          messageCount++;
        } else if (entry.type === "tool_call" || entry.type === "tool_result") {
          toolCount++;
        }
      } catch {
        // Skip malformed lines
      }
    }

    return {
      sessionId: meta?.id,
      cliVersion: meta?.cli_version,
      model,
      cwd: meta?.cwd,
      messageCount,
      toolCount,
      timestamp: meta?.timestamp,
    };
  } catch (error) {
    console.error("[codex-local] Error parsing session:", error.message);
    return null;
  }
}

/**
 * Detect patterns from collected data
 */
function detectPatterns(historySessions) {
  const patterns = {};
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;

  // Count prompts in last hour
  let promptsLastHour = 0;
  for (const session of historySessions) {
    if (session.lastTs > oneHourAgo) {
      promptsLastHour += session.promptCount;
    }
  }

  if (promptsLastHour > THRESHOLDS.messagesPerHour.error) {
    patterns.highPromptFrequency = "error";
  } else if (promptsLastHour > THRESHOLDS.messagesPerHour.warning) {
    patterns.highPromptFrequency = "warning";
  }

  // Check for long sessions
  for (const session of historySessions) {
    const durationMs = session.lastTs - session.firstTs;
    const durationMinutes = durationMs / 60000;

    if (durationMinutes > THRESHOLDS.sessionDurationMinutes.error) {
      patterns.longRunningSession = "error";
      break;
    } else if (durationMinutes > THRESHOLDS.sessionDurationMinutes.warning) {
      patterns.longRunningSession = "warning";
    }
  }

  return patterns;
}

/**
 * Collect and emit events
 */
async function collectAndEmit() {
  const now = Date.now();

  // Read data sources
  const [historySessions, recentSessionFiles] = await Promise.all([
    readHistory(),
    findRecentSessions(),
  ]);

  // Detect patterns
  const patterns = detectPatterns(historySessions);

  // Emit history-based session snapshots
  const twoHoursAgo = now - 2 * 60 * 60 * 1000;
  const recentHistorySessions = historySessions.filter((s) => s.lastTs > twoHoursAgo);

  for (const session of recentHistorySessions.slice(0, 3)) {
    const durationMinutes = Math.round((session.lastTs - session.firstTs) / 60000);

    const event = {
      ts: now,
      source: "local",
      agent: "codex",
      event: "session_snapshot",
      sessionId: session.sessionId,
      promptCount: session.promptCount,
      durationMinutes,
      patterns: Object.keys(patterns).length > 0 ? patterns : undefined,
    };

    await appendJsonLine(CODEX_LOCAL_FILE, event);

    console.log(
      `[codex-local] session ${session.sessionId.slice(0, 8)}... · ${session.promptCount} prompts · ${durationMinutes}min`
    );
  }

  // Emit session file info for most recent sessions
  for (const sessionFile of recentSessionFiles.slice(0, 3)) {
    const parsed = await parseSessionFile(sessionFile.path);
    if (!parsed) continue;

    const event = {
      ts: now,
      source: "local",
      agent: "codex",
      event: "session_file",
      sessionId: parsed.sessionId,
      cliVersion: parsed.cliVersion,
      model: parsed.model,
      messageCount: parsed.messageCount,
      toolCount: parsed.toolCount,
      date: sessionFile.date,
      patterns: Object.keys(patterns).length > 0 ? patterns : undefined,
    };

    await appendJsonLine(CODEX_LOCAL_FILE, event);

    console.log(
      `[codex-local] file ${sessionFile.name.slice(0, 20)}... · ${parsed.messageCount} msgs · ${parsed.toolCount} tools`
    );
  }

  // Emit daily summary
  const todaySessions = historySessions.filter((s) => {
    const sessionDate = new Date(s.firstTs).toDateString();
    return sessionDate === new Date().toDateString();
  });

  const totalPrompts = todaySessions.reduce((sum, s) => sum + s.promptCount, 0);

  if (totalPrompts > 0) {
    const summaryEvent = {
      ts: now,
      source: "local",
      agent: "codex",
      event: "daily_stats",
      date: new Date().toISOString().split("T")[0],
      sessionCount: todaySessions.length,
      promptCount: totalPrompts,
      patterns: Object.keys(patterns).length > 0 ? patterns : undefined,
    };

    await appendJsonLine(CODEX_LOCAL_FILE, summaryEvent);

    console.log(
      `[codex-local] daily stats · ${todaySessions.length} sessions · ${totalPrompts} prompts`
    );
  }

  // Log patterns
  const patternKeys = Object.keys(patterns);
  if (patternKeys.length > 0) {
    console.log(`[codex-local] patterns detected: ${patternKeys.join(", ")}`);
  }
}

/**
 * Main loop
 */
async function start() {
  await ensureDirectory();

  console.log("[codex-local] Codex local collector started");
  console.log(`[codex-local] Reading from: ${CODEX_PATHS.history}`);
  console.log(`[codex-local] Writing to: ${CODEX_LOCAL_FILE}`);
  console.log(`[codex-local] Poll interval: ${POLL_INTERVAL_MS / 1000}s`);

  // Initial collection
  await collectAndEmit();

  // Periodic collection
  setInterval(async () => {
    try {
      await collectAndEmit();
    } catch (error) {
      console.error("[codex-local] Collection error:", error.message);
    }
  }, POLL_INTERVAL_MS);

  // Rotation
  setInterval(() => {
    rotateJsonlIfNeeded(CODEX_LOCAL_FILE, 500);
  }, ROTATION_INTERVAL_MS);
}

process.on("SIGINT", () => {
  console.log("[codex-local] Shutting down...");
  process.exit(0);
});

start().catch((error) => {
  console.error("[codex-local] Failed to start:", error);
  process.exit(1);
});
