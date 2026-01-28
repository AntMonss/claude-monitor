import path from "node:path";
import process from "node:process";
import si from "systeminformation";
import {
  DATA_DIR,
  FILE_NAMES,
  ensureDirectory,
  readWatchingState,
  appendJsonLine,
  rotateJsonlIfNeeded,
} from "../lib/state.mjs";

const SYSTEM_LOG = path.join(DATA_DIR, FILE_NAMES.system);
const PROCESS_LOG = path.join(DATA_DIR, FILE_NAMES.process);
const SAMPLE_INTERVAL_MS = Number(process.env.AI_DASHBOARD_INTERVAL_MS ?? 2000);
const WATCHER_KEYWORDS = [
  "node",
  "vite",
  "docker",
  "codex",
  "claude",
  "cursor",
];
const TOP_PROCESS_COUNT = 4;
const ROTATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function summarizeNetwork(stats = []) {
  return stats.reduce(
    (acc, iface) => ({
      rx: acc.rx + (iface.rx_sec ?? 0),
      tx: acc.tx + (iface.tx_sec ?? 0),
    }),
    { rx: 0, tx: 0 },
  );
}

function pickTopProcesses(list = []) {
  const sorted = [...list].sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0));
  return sorted.slice(0, TOP_PROCESS_COUNT).map((proc) => ({
    pid: proc.pid,
    name: proc.name,
    cpu: Number(proc.cpu?.toFixed(2)) ?? proc.cpu,
    mem: Number(proc.mem?.toFixed(2)) ?? proc.mem,
  }));
}

function filterWatchers(list = []) {
  return list
    .filter((proc) => {
      if (!proc.name) return false;
      const name = proc.name.toLowerCase();
      return WATCHER_KEYWORDS.some((keyword) => name.includes(keyword));
    })
    .slice(0, 6)
    .map((proc) => ({
      pid: proc.pid,
      name: proc.name,
      cpu: Number(proc.cpu?.toFixed(2)) ?? proc.cpu,
      mem: Number(proc.mem?.toFixed(2)) ?? proc.mem,
    }));
}

async function captureSample() {
  const state = await readWatchingState();
  const ts = Date.now();

  if (!state.enabled) {
    console.log(
      `[ai-dashboard] collectors paused since ${new Date(state.updatedAt).toLocaleTimeString()}`,
    );
    return;
  }

  try {
    const [load, mem, fsStats, networkStats, procSnapshot, diskIO] =
      await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.fsStats(),
        si.networkStats(),
        si.processes(),
        si.disksIO(),
      ]);

    const netSummary = summarizeNetwork(networkStats);
    const topProcesses = pickTopProcesses(procSnapshot.list ?? []);
    const watcherProcesses = filterWatchers(procSnapshot.list ?? []);

    const systemEvent = {
      ts,
      cpuLoad: load.currentLoad,
      cpuSystem: load.currentLoadSystem,
      cpuUser: load.currentLoadUser,
      cpuIdle: load.currentLoadIdle,
      memTotalMb: Number((mem.total / 1024 / 1024).toFixed(2)),
      memUsedMb: Number(((mem.total - mem.available) / 1024 / 1024).toFixed(2)),
      swapUsedMb: Number((mem.swapused / 1024 / 1024).toFixed(2)),
      diskBusy: fsStats.busy,
      diskReadCnt: diskIO.rIO,
      diskWriteCnt: diskIO.wIO,
      networkRxPerSec: netSummary.rx,
      networkTxPerSec: netSummary.tx,
      watcherCount: watcherProcesses.length,
      topProcessName: topProcesses?.[0]?.name ?? null,
    };

    const processEvent = {
      ts,
      topProcesses,
      watchers: watcherProcesses,
    };

    await Promise.all([
      appendJsonLine(SYSTEM_LOG, systemEvent),
      appendJsonLine(PROCESS_LOG, processEvent),
    ]);

    console.log(
      `[ai-dashboard] ${new Date(ts).toISOString()} · cpu=${
        systemEvent.cpuLoad?.toFixed(1) ?? "—"
      }% · watchers=${watcherProcesses.length}`,
    );
  } catch (error) {
    console.error("[ai-dashboard] failed to capture sample:", error);
  }
}

async function rotateFiles() {
  await rotateJsonlIfNeeded(SYSTEM_LOG, 500);
  await rotateJsonlIfNeeded(PROCESS_LOG, 500);
}

async function startCollector() {
  await ensureDirectory();
  await captureSample();

  const sampleTimer = setInterval(captureSample, SAMPLE_INTERVAL_MS);
  const rotationTimer = setInterval(rotateFiles, ROTATION_INTERVAL_MS);

  process.on("SIGINT", () => {
    clearInterval(sampleTimer);
    clearInterval(rotationTimer);
    console.log("[ai-dashboard] collector stopped");
    process.exit(0);
  });
}

startCollector().catch((error) => {
  console.error("[ai-dashboard] collector failed to start:", error);
  process.exit(1);
});
