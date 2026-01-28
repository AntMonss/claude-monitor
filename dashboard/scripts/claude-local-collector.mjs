/**
 * Claude Code Local Collector
 *
 * Reads local Claude Code files (~/.claude/) and generates events for passive monitoring.
 * Runs every 30 seconds to minimize I/O impact.
 *
 * Data sources:
 * - ~/.claude/history.jsonl - Session activity (messages, timestamps)
 * - ~/.claude/stats-cache.json - Daily aggregated stats
 * - ~/.claude/tasks/ - Task status files
 *
 * Pattern detection thresholds:
 * - Message/Tool Ratio: > 7.0 warning, > 10.0 error
 * - Session Duration: > 4h warning, > 8h error
 * - Blocked Tasks Age: > 3 days warning, > 7 days error
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DATA_DIR,
  FILE_NAMES,
  CLAUDE_PATHS,
  ensureDirectory,
  appendJsonLine,
  rotateJsonlIfNeeded,
} from "../lib/state.mjs";

const CLAUDE_LOCAL_FILE = path.join(DATA_DIR, FILE_NAMES.claudeLocal);
const POLL_INTERVAL_MS = 30_000; // 30 seconds
const ROTATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Pattern detection thresholds
const THRESHOLDS = {
  messageToolRatio: { warning: 7.0, error: 10.0 },
  sessionDurationMinutes: { warning: 240, error: 480 }, // 4h, 8h
  blockedTaskAgeDays: { warning: 3, error: 7 },
};

/**
 * Read last N lines from a file efficiently (tail-like)
 * Reads from end of file to minimize memory usage on large files
 */
async function readLastLines(filePath, maxLines = 1000) {
  try {
    const stat = await fs.stat(filePath);
    const fileSize = stat.size;

    // For small files, just read the whole thing
    if (fileSize < 100 * 1024) { // < 100KB
      const raw = await fs.readFile(filePath, "utf8");
      const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
      return lines.slice(-maxLines);
    }

    // For larger files, read chunks from the end
    const handle = await fs.open(filePath, "r");
    try {
      const chunkSize = Math.min(fileSize, 512 * 1024); // Read up to 512KB from end
      const buffer = Buffer.alloc(chunkSize);
      const startPos = Math.max(0, fileSize - chunkSize);

      await handle.read(buffer, 0, chunkSize, startPos);
      const content = buffer.toString("utf8");
      const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);

      // If we started mid-file, first line might be incomplete - skip it
      if (startPos > 0 && lines.length > 0) {
        lines.shift();
      }

      return lines.slice(-maxLines);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("[claude-local] Error reading file tail:", error.message);
    }
    return [];
  }
}

/**
 * Read and parse history.jsonl to get active sessions
 * Only reads last 1000 lines for performance
 */
async function readHistory() {
  try {
    const lines = await readLastLines(CLAUDE_PATHS.history, 1000);

    // Group by sessionId to get session info
    const sessions = new Map();
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (!entry.sessionId) continue;

        // Only consider recent sessions (last 24h)
        if (entry.timestamp && entry.timestamp < oneDayAgo) continue;

        const session = sessions.get(entry.sessionId) || {
          sessionId: entry.sessionId,
          project: entry.project,
          firstTs: entry.timestamp,
          lastTs: entry.timestamp,
          messageCount: 0,
        };

        session.messageCount++;
        if (entry.timestamp < session.firstTs) session.firstTs = entry.timestamp;
        if (entry.timestamp > session.lastTs) session.lastTs = entry.timestamp;
        session.project = entry.project || session.project;

        sessions.set(entry.sessionId, session);
      } catch {
        // Skip malformed lines
      }
    }

    return Array.from(sessions.values());
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("[claude-local] Error reading history:", error.message);
    }
    return [];
  }
}

/**
 * Read stats-cache.json for daily stats
 */
async function readStatsCache() {
  try {
    const raw = await fs.readFile(CLAUDE_PATHS.statsCache, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("[claude-local] Error reading stats-cache:", error.message);
    }
    return null;
  }
}

/**
 * Read task files to find blocked tasks
 */
async function readTasks() {
  const tasks = [];

  try {
    const taskDirs = await fs.readdir(CLAUDE_PATHS.tasks);

    for (const dir of taskDirs.slice(0, 20)) {
      // Limit to 20 task dirs
      const taskDir = path.join(CLAUDE_PATHS.tasks, dir);
      try {
        const stat = await fs.stat(taskDir);
        if (!stat.isDirectory()) continue;

        const files = await fs.readdir(taskDir);
        for (const file of files.filter((f) => f.endsWith(".json")).slice(0, 10)) {
          try {
            const taskFile = path.join(taskDir, file);
            const raw = await fs.readFile(taskFile, "utf8");
            // Handle potential multiple JSON objects in the file
            const jsonStr = raw.split("}{")[0] + (raw.includes("}{") ? "}" : "");
            const task = JSON.parse(jsonStr);
            if (task.status && task.status !== "completed") {
              tasks.push({
                id: task.id,
                subject: task.subject,
                status: task.status,
                blockedBy: task.blockedBy || [],
                dir,
              });
            }
          } catch {
            // Skip malformed task files
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("[claude-local] Error reading tasks:", error.message);
    }
  }

  return tasks;
}

/**
 * Detect GLOBAL patterns (not session-specific)
 * For session-specific patterns, use detectSessionPatterns
 */
function detectGlobalPatterns(statsCache, tasks) {
  const patterns = {};

  // Calculate message/tool ratio from today's stats
  if (statsCache?.dailyActivity?.length > 0) {
    const today = statsCache.dailyActivity[statsCache.dailyActivity.length - 1];
    if (today.messageCount && today.toolCallCount) {
      const ratio = today.messageCount / Math.max(1, today.toolCallCount);
      if (ratio > THRESHOLDS.messageToolRatio.error) {
        patterns.highMessageToolRatio = { severity: "error", ratio: ratio.toFixed(1) };
      } else if (ratio > THRESHOLDS.messageToolRatio.warning) {
        patterns.highMessageToolRatio = { severity: "warning", ratio: ratio.toFixed(1) };
      }
    }
  }

  // Check for blocked tasks
  const blockedTasks = tasks.filter(
    (t) => t.status === "in_progress" || (t.blockedBy && t.blockedBy.length > 0)
  );
  if (blockedTasks.length > 3) {
    patterns.blockedTasks = { severity: "warning", count: blockedTasks.length };
  }

  return patterns;
}

/**
 * Detect patterns specific to a session
 */
function detectSessionPatterns(session) {
  const patterns = {};
  const durationMs = session.lastTs - session.firstTs;
  const durationMinutes = durationMs / 60000;

  // Check for long-running session
  if (durationMinutes > THRESHOLDS.sessionDurationMinutes.error) {
    const projectName = session.project?.split("/").pop() || "unknown";
    patterns.longRunningSession = {
      severity: "error",
      sessionId: session.sessionId?.slice(0, 8),
      project: projectName,
      durationMinutes: Math.round(durationMinutes),
    };
  } else if (durationMinutes > THRESHOLDS.sessionDurationMinutes.warning) {
    const projectName = session.project?.split("/").pop() || "unknown";
    patterns.longRunningSession = {
      severity: "warning",
      sessionId: session.sessionId?.slice(0, 8),
      project: projectName,
      durationMinutes: Math.round(durationMinutes),
    };
  }

  return patterns;
}

/**
 * Generate events from collected data
 */
async function collectAndEmit() {
  const now = Date.now();

  // Read all data sources
  const [sessions, statsCache, tasks] = await Promise.all([
    readHistory(),
    readStatsCache(),
    readTasks(),
  ]);

  // Detect global patterns (ratio, blocked tasks)
  const globalPatterns = detectGlobalPatterns(statsCache, tasks);

  // Emit session snapshots for recent active sessions (last 2 hours)
  const twoHoursAgo = now - 2 * 60 * 60 * 1000;
  const recentSessions = sessions.filter((s) => s.lastTs > twoHoursAgo);

  for (const session of recentSessions.slice(0, 5)) {
    // Limit to 5 sessions
    const durationMs = session.lastTs - session.firstTs;
    const durationMinutes = Math.round(durationMs / 60000);

    // Detect patterns specific to THIS session
    const sessionPatterns = detectSessionPatterns(session);
    const allPatterns = { ...globalPatterns, ...sessionPatterns };

    const event = {
      ts: now,
      source: "local",
      event: "session_snapshot",
      sessionId: session.sessionId,
      messageCount: session.messageCount,
      durationMinutes,
      project: session.project,
      patterns: Object.keys(allPatterns).length > 0 ? allPatterns : undefined,
    };

    await appendJsonLine(CLAUDE_LOCAL_FILE, event);

    console.log(
      `[claude-local] session ${session.sessionId.slice(0, 8)}... · ${session.messageCount} msgs · ${durationMinutes}min`
    );
  }

  // Emit daily stats event
  if (statsCache?.dailyActivity?.length > 0) {
    const today = statsCache.dailyActivity[statsCache.dailyActivity.length - 1];
    const ratio =
      today.toolCallCount > 0
        ? (today.messageCount / today.toolCallCount).toFixed(1)
        : null;

    const statsEvent = {
      ts: now,
      source: "local",
      event: "daily_stats",
      date: today.date,
      messageCount: today.messageCount,
      toolCallCount: today.toolCallCount,
      sessionCount: today.sessionCount,
      messageToolRatio: ratio ? parseFloat(ratio) : undefined,
      totalSessions: statsCache.totalSessions,
      totalMessages: statsCache.totalMessages,
      patterns: Object.keys(globalPatterns).length > 0 ? globalPatterns : undefined,
    };

    await appendJsonLine(CLAUDE_LOCAL_FILE, statsEvent);

    console.log(
      `[claude-local] daily stats · ${today.messageCount} msgs · ${today.toolCallCount} tools · ratio ${ratio}`
    );
  }

  // Emit blocked tasks summary
  const blockedTasks = tasks.filter(
    (t) => t.status !== "completed" && t.blockedBy && t.blockedBy.length > 0
  );
  const pendingTasks = tasks.filter(
    (t) => t.status === "pending" || t.status === "in_progress"
  );

  if (pendingTasks.length > 0) {
    const taskEvent = {
      ts: now,
      source: "local",
      event: "task_status",
      pendingCount: pendingTasks.length,
      blockedCount: blockedTasks.length,
      tasks: pendingTasks.slice(0, 5).map((t) => ({
        id: t.id,
        subject: t.subject?.slice(0, 50),
        status: t.status,
      })),
      patterns: blockedTasks.length > 3 ? { manyBlockedTasks: { severity: "warning", count: blockedTasks.length } } : undefined,
    };

    await appendJsonLine(CLAUDE_LOCAL_FILE, taskEvent);

    console.log(
      `[claude-local] tasks · ${pendingTasks.length} pending · ${blockedTasks.length} blocked`
    );
  }

  // Log patterns if any
  const patternKeys = Object.keys(globalPatterns);
  if (patternKeys.length > 0) {
    console.log(
      `[claude-local] patterns detected: ${patternKeys.join(", ")}`
    );
  }
}

/**
 * Main loop
 */
async function start() {
  await ensureDirectory();

  console.log("[claude-local] Claude Code local collector started");
  console.log(`[claude-local] Reading from: ${CLAUDE_PATHS.history}`);
  console.log(`[claude-local] Writing to: ${CLAUDE_LOCAL_FILE}`);
  console.log(`[claude-local] Poll interval: ${POLL_INTERVAL_MS / 1000}s`);

  // Initial collection
  await collectAndEmit();

  // Periodic collection
  setInterval(async () => {
    try {
      await collectAndEmit();
    } catch (error) {
      console.error("[claude-local] Collection error:", error.message);
    }
  }, POLL_INTERVAL_MS);

  // Rotation
  setInterval(() => {
    rotateJsonlIfNeeded(CLAUDE_LOCAL_FILE, 500);
  }, ROTATION_INTERVAL_MS);
}

process.on("SIGINT", () => {
  console.log("[claude-local] Shutting down...");
  process.exit(0);
});

start().catch((error) => {
  console.error("[claude-local] Failed to start:", error);
  process.exit(1);
});
