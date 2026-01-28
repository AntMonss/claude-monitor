/**
 * Lightweight OTLP Collector for Claude Code telemetry
 *
 * Receives OpenTelemetry logs/events from Claude Code and writes them to JSONL.
 * Listens on localhost:4319 (HTTP/JSON protocol)
 *
 * Usage:
 *   1. Start this collector: npm run otel-collector
 *   2. Launch Claude Code with:
 *      CLAUDE_CODE_ENABLE_TELEMETRY=1 \
 *      OTEL_LOGS_EXPORTER=otlp \
 *      OTEL_METRICS_EXPORTER=otlp \
 *      OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
 *      OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4319 \
 *      claude
 */

import express from "express";
import path from "node:path";
import process from "node:process";
import {
  DATA_DIR,
  FILE_NAMES,
  ensureDirectory,
  appendJsonLine,
  rotateJsonlIfNeeded,
} from "../lib/state.mjs";

const CLAUDE_EVENTS_FILE = path.join(DATA_DIR, FILE_NAMES.claude);
const PORT = Number(process.env.OTEL_COLLECTOR_PORT ?? 4319);
const ROTATION_INTERVAL_MS = 5 * 60 * 1000;

const app = express();

// OTLP sends JSON or protobuf - we'll handle JSON
app.use(express.json({ limit: "10mb" }));

// Also accept protobuf as raw buffer (we'll skip parsing it for now)
app.use(express.raw({ type: "application/x-protobuf", limit: "10mb" }));

/**
 * Extract relevant events from OTLP logs payload
 */
function extractEventsFromLogs(payload) {
  const events = [];

  // OTLP logs structure: { resourceLogs: [{ scopeLogs: [{ logRecords: [...] }] }] }
  const resourceLogs = payload.resourceLogs ?? [];

  for (const resourceLog of resourceLogs) {
    const scopeLogs = resourceLog.scopeLogs ?? [];

    for (const scopeLog of scopeLogs) {
      const logRecords = scopeLog.logRecords ?? [];

      for (const record of logRecords) {
        const event = parseLogRecord(record);
        if (event) {
          events.push(event);
        }
      }
    }
  }

  return events;
}

/**
 * Parse a single OTLP log record into our event format
 */
function parseLogRecord(record) {
  // Extract attributes into a flat object
  const attrs = {};
  for (const attr of record.attributes ?? []) {
    const key = attr.key;
    const value = extractAttributeValue(attr.value);
    attrs[key] = value;
  }

  // Get event name
  const eventName = attrs["event.name"] ?? record.severityText ?? "unknown";

  // Skip non-Claude events
  if (!eventName.startsWith("claude_code.") && !attrs["event.name"]?.includes("claude")) {
    // Still include if it has relevant attributes
    if (!attrs.duration_ms && !attrs.tool_name && !attrs.model) {
      return null;
    }
  }

  // Build our event object
  const event = {
    ts: record.timeUnixNano
      ? Math.floor(Number(record.timeUnixNano) / 1_000_000)
      : Date.now(),
    event: eventName.replace("claude_code.", ""),
    ...attrs,
  };

  // Log interesting events
  if (event.duration_ms || event.event === "api_request" || event.event === "tool_result") {
    console.log(
      `[otel-collector] ${new Date(event.ts).toISOString()} · ${event.event} · ${event.duration_ms ?? "—"}ms`
    );
  }

  return event;
}

/**
 * Extract value from OTLP attribute value object
 */
function extractAttributeValue(valueObj) {
  if (!valueObj) return null;

  if (valueObj.stringValue !== undefined) return valueObj.stringValue;
  if (valueObj.intValue !== undefined) return Number(valueObj.intValue);
  if (valueObj.doubleValue !== undefined) return valueObj.doubleValue;
  if (valueObj.boolValue !== undefined) return valueObj.boolValue;

  // Handle arrays
  if (valueObj.arrayValue) {
    return (valueObj.arrayValue.values ?? []).map(extractAttributeValue);
  }

  // Handle maps
  if (valueObj.kvlistValue) {
    const obj = {};
    for (const kv of valueObj.kvlistValue.values ?? []) {
      obj[kv.key] = extractAttributeValue(kv.value);
    }
    return obj;
  }

  return null;
}

/**
 * Extract metrics from OTLP metrics payload
 */
function extractMetricsFromPayload(payload) {
  const metrics = [];

  const resourceMetrics = payload.resourceMetrics ?? [];

  for (const resourceMetric of resourceMetrics) {
    const scopeMetrics = resourceMetric.scopeMetrics ?? [];

    for (const scopeMetric of scopeMetrics) {
      const metricsList = scopeMetric.metrics ?? [];

      for (const metric of metricsList) {
        const parsed = parseMetric(metric);
        if (parsed) {
          metrics.push(parsed);
        }
      }
    }
  }

  return metrics;
}

/**
 * Parse a single OTLP metric
 */
function parseMetric(metric) {
  const name = metric.name;

  // Only care about Claude Code metrics
  if (!name?.startsWith("claude_code.")) {
    return null;
  }

  // Extract data points (could be sum, gauge, histogram)
  let dataPoints = [];
  if (metric.sum) {
    dataPoints = metric.sum.dataPoints ?? [];
  } else if (metric.gauge) {
    dataPoints = metric.gauge.dataPoints ?? [];
  } else if (metric.histogram) {
    dataPoints = metric.histogram.dataPoints ?? [];
  }

  if (dataPoints.length === 0) return null;

  // Take the latest data point
  const point = dataPoints[dataPoints.length - 1];

  // Extract attributes
  const attrs = {};
  for (const attr of point.attributes ?? []) {
    attrs[attr.key] = extractAttributeValue(attr.value);
  }

  const value =
    point.asInt !== undefined
      ? Number(point.asInt)
      : point.asDouble !== undefined
        ? point.asDouble
        : point.sum !== undefined
          ? point.sum
          : null;

  return {
    ts: point.timeUnixNano
      ? Math.floor(Number(point.timeUnixNano) / 1_000_000)
      : Date.now(),
    metric: name.replace("claude_code.", ""),
    value,
    ...attrs,
  };
}

// OTLP Logs endpoint
app.post("/v1/logs", async (req, res) => {
  try {
    if (Buffer.isBuffer(req.body)) {
      // Protobuf - we'd need a protobuf parser, skip for now
      console.log("[otel-collector] Received protobuf logs (skipping, use http/json)");
      return res.status(200).json({});
    }

    const events = extractEventsFromLogs(req.body);

    for (const event of events) {
      await appendJsonLine(CLAUDE_EVENTS_FILE, event);
    }

    res.status(200).json({});
  } catch (error) {
    console.error("[otel-collector] Error processing logs:", error);
    res.status(500).json({ error: error.message });
  }
});

// OTLP Metrics endpoint
app.post("/v1/metrics", async (req, res) => {
  try {
    if (Buffer.isBuffer(req.body)) {
      console.log("[otel-collector] Received protobuf metrics (skipping, use http/json)");
      return res.status(200).json({});
    }

    const metrics = extractMetricsFromPayload(req.body);

    for (const metric of metrics) {
      await appendJsonLine(CLAUDE_EVENTS_FILE, metric);
    }

    res.status(200).json({});
  } catch (error) {
    console.error("[otel-collector] Error processing metrics:", error);
    res.status(500).json({ error: error.message });
  }
});

// OTLP Traces endpoint (not used by Claude Code but good to have)
app.post("/v1/traces", (req, res) => {
  res.status(200).json({});
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", port: PORT });
});

// Rotation
setInterval(() => {
  rotateJsonlIfNeeded(CLAUDE_EVENTS_FILE, 500);
}, ROTATION_INTERVAL_MS);

async function start() {
  await ensureDirectory();

  app.listen(PORT, () => {
    console.log(`[otel-collector] OTLP collector listening on http://localhost:${PORT}`);
    console.log(`[otel-collector] Launch Claude Code with:`);
    console.log(`  CLAUDE_CODE_ENABLE_TELEMETRY=1 \\`);
    console.log(`  OTEL_LOGS_EXPORTER=otlp \\`);
    console.log(`  OTEL_METRICS_EXPORTER=otlp \\`);
    console.log(`  OTEL_EXPORTER_OTLP_PROTOCOL=http/json \\`);
    console.log(`  OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${PORT} \\`);
    console.log(`  claude`);
  });
}

process.on("SIGINT", () => {
  console.log("[otel-collector] Shutting down...");
  process.exit(0);
});

start().catch((error) => {
  console.error("[otel-collector] Failed to start:", error);
  process.exit(1);
});
