import path from "node:path";
import process from "node:process";
import {
  DATA_DIR,
  FILE_NAMES,
  ensureDirectory,
  readWatchingState,
  appendJsonLine,
  rotateJsonlIfNeeded,
} from "../lib/state.mjs";

const LATENCY_LOG = path.join(DATA_DIR, FILE_NAMES.latency);
const SAMPLE_INTERVAL_MS = Number(
  process.env.AI_DASHBOARD_LATENCY_INTERVAL_MS ?? 10000,
);
const ROTATION_INTERVAL_MS = 5 * 60 * 1000;

// Endpoints to monitor — only external APIs
// Local servers are NOT monitored to avoid interfering with other projects
const ENDPOINTS = [
  { name: "anthropic", url: "https://api.anthropic.com", timeout: 8000 },
  { name: "openai", url: "https://api.openai.com", timeout: 8000 },
];

async function measureLatency(endpoint) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), endpoint.timeout);

  const start = performance.now();
  try {
    const response = await fetch(endpoint.url, {
      method: "HEAD",
      signal: controller.signal,
      headers: { "Cache-Control": "no-cache" },
    });
    clearTimeout(timeoutId);
    const latencyMs = performance.now() - start;

    return {
      name: endpoint.name,
      url: endpoint.url,
      latencyMs: Math.round(latencyMs),
      status: response.status,
      ok: response.ok || response.status < 500,
      error: null,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    const latencyMs = performance.now() - start;

    return {
      name: endpoint.name,
      url: endpoint.url,
      latencyMs: Math.round(latencyMs),
      status: null,
      ok: false,
      error:
        error.name === "AbortError" ? "timeout" : error.message || "unknown",
    };
  }
}

async function captureSample() {
  const state = await readWatchingState();
  const ts = Date.now();

  if (!state.enabled) {
    console.log(
      `[ai-dashboard] latency monitor paused since ${new Date(state.updatedAt).toLocaleTimeString()}`,
    );
    return;
  }

  try {
    const results = await Promise.all(ENDPOINTS.map(measureLatency));

    const event = {
      ts,
      endpoints: results,
      // Summary stats for quick access
      anthropicMs:
        results.find((r) => r.name === "anthropic")?.latencyMs ?? null,
      openaiMs: results.find((r) => r.name === "openai")?.latencyMs ?? null,
      anyTimeout: results.some((r) => r.error === "timeout"),
      anyError: results.some((r) => r.error && r.error !== "timeout"),
    };

    await appendJsonLine(LATENCY_LOG, event);

    // Log summary
    const summary = results
      .map((r) => `${r.name}=${r.latencyMs ?? r.error}ms`)
      .join(" · ");
    console.log(
      `[ai-dashboard] ${new Date(ts).toISOString()} · latency: ${summary}`,
    );
  } catch (error) {
    console.error("[ai-dashboard] failed to capture latency sample:", error);
  }
}

async function rotateFiles() {
  await rotateJsonlIfNeeded(LATENCY_LOG, 500);
}

async function startMonitor() {
  await ensureDirectory();
  await captureSample();

  const sampleTimer = setInterval(captureSample, SAMPLE_INTERVAL_MS);
  const rotationTimer = setInterval(rotateFiles, ROTATION_INTERVAL_MS);

  process.on("SIGINT", () => {
    clearInterval(sampleTimer);
    clearInterval(rotationTimer);
    console.log("[ai-dashboard] latency monitor stopped");
    process.exit(0);
  });
}

startMonitor().catch((error) => {
  console.error("[ai-dashboard] latency monitor failed to start:", error);
  process.exit(1);
});
