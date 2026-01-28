import { useEffect, useMemo, useState, useCallback } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Cpu,
  Eye,
  EyeOff,
  Globe,
  HardDrive,
  MemoryStick,
  Network,
  Server,
  Terminal,
  Zap,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { cn, formatTimestamp } from "@/lib/utils";

const API_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? "";

type SystemMetricsRecord = {
  ts: number;
  cpuLoad?: number;
  cpuSystem?: number;
  cpuUser?: number;
  memUsedMb?: number;
  memTotalMb?: number;
  swapUsedMb?: number;
  diskReadCnt?: number;
  diskWriteCnt?: number;
  networkRxPerSec?: number;
  networkTxPerSec?: number;
  watcherCount?: number;
  topProcessName?: string | null;
};

type ProcessStatsRecord = {
  ts: number;
  watchers?: Array<{ pid?: number; name?: string; cpu?: number; mem?: number }>;
};

type CodexEventRecord = {
  ts?: number;
  measurement?: string;
  raw?: string;
  note?: string;
  total_ms?: number;
  api?: number;
};

type LatencyEndpoint = {
  name: string;
  url: string;
  latencyMs: number | null;
  status: number | null;
  ok: boolean | null;
  error: string | null;
};

type LatencyEventRecord = {
  ts: number;
  endpoints: LatencyEndpoint[];
  anthropicMs: number | null;
  openaiMs: number | null;
  anyTimeout: boolean;
  anyError: boolean;
};

// Claude Code OTEL events (from otel-collector)
type ClaudeEventRecord = {
  ts: number;
  event: string; // "api_request", "tool_result", "api_error", "user_prompt"
  duration_ms?: number;
  model?: string;
  tool_name?: string;
  success?: string;
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  error?: string;
  status_code?: number;
};

type EventsPayload = {
  systemMetrics: SystemMetricsRecord[];
  processStats: ProcessStatsRecord[];
  codexEvents: CodexEventRecord[];
  latencyEvents: LatencyEventRecord[];
  claudeEvents: ClaudeEventRecord[];
};

type TimelineEntry =
  | { kind: "system"; ts: number; label: string; data: SystemMetricsRecord }
  | { kind: "codex"; ts: number; label: string; data: CodexEventRecord }
  | { kind: "latency"; ts: number; label: string; data: LatencyEventRecord }
  | { kind: "claude"; ts: number; label: string; data: ClaudeEventRecord };

export default function App() {
  const [events, setEvents] = useState<EventsPayload>({
    systemMetrics: [],
    processStats: [],
    codexEvents: [],
    latencyEvents: [],
    claudeEvents: [],
  });

  const [watchingState, setWatchingState] = useState<{
    enabled: boolean;
    updatedAt: number;
  }>({
    enabled: true,
    updatedAt: Date.now(),
  });

  const [loadingToggle, setLoadingToggle] = useState(false);
  const [selected, setSelected] = useState<TimelineEntry | null>(null);

  const apiBase = API_ORIGIN.replace(/\/$/, "");
  const apiUrl = (path: string) => `${apiBase}${path}`;

  const fetchEvents = async () => {
    try {
      const response = await fetch(apiUrl("/api/events"));
      if (!response.ok) throw new Error("failed to load events");
      const payload = (await response.json()) as EventsPayload;
      setEvents(payload);
    } catch (error) {
      console.error("[App] could not load events", error);
    }
  };

  const fetchWatchingState = async () => {
    try {
      const response = await fetch(apiUrl("/api/state"));
      if (!response.ok) throw new Error("failed to load watching state");
      const payload = await response.json();
      setWatchingState({
        enabled: payload.enabled ?? true,
        updatedAt: payload.updatedAt ?? Date.now(),
      });
    } catch (error) {
      console.error("[App] could not load watching state", error);
    }
  };

  const toggleWatching = async () => {
    setLoadingToggle(true);
    try {
      const target = !watchingState.enabled;
      const response = await fetch(apiUrl("/api/state"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: target }),
      });
      if (!response.ok) throw new Error("failed to toggle watching");
      const payload = await response.json();
      setWatchingState({
        enabled: payload.enabled ?? target,
        updatedAt: payload.updatedAt ?? Date.now(),
      });
    } catch (error) {
      console.error("[App] could not toggle watching", error);
    } finally {
      setLoadingToggle(false);
    }
  };

  useEffect(() => {
    fetchEvents();
    fetchWatchingState();
    const interval = setInterval(fetchEvents, 5000);
    const stateInterval = setInterval(fetchWatchingState, 12000);
    return () => {
      clearInterval(interval);
      clearInterval(stateInterval);
    };
  }, []);

  const timeline = useMemo<TimelineEntry[]>(() => {
    const systemEntries = events.systemMetrics.slice(-20).map((event) => ({
      kind: "system" as const,
      ts: event.ts,
      label: `${event.cpuLoad?.toFixed(0) ?? "—"}%`,
      data: event,
    }));

    const codexEntries = events.codexEvents.map((event) => ({
      kind: "codex" as const,
      ts: typeof event.ts === "number" ? event.ts : Date.now(),
      label: (event.measurement ?? "Codex").toUpperCase(),
      data: event,
    }));

    const latencyEntries = events.latencyEvents.slice(-10).map((event) => ({
      kind: "latency" as const,
      ts: event.ts,
      label: `${event.anthropicMs ?? "—"}ms`,
      data: event,
    }));

    // Claude Code OTEL events (api_request and tool_result)
    const claudeEntries = events.claudeEvents
      .filter((e) => e.event === "api_request" || e.event === "tool_result")
      .slice(-15)
      .map((event) => ({
        kind: "claude" as const,
        ts: event.ts,
        label: event.event === "api_request"
          ? `${event.duration_ms ?? "—"}ms`
          : event.tool_name ?? "tool",
        data: event,
      }));

    const merged = [...systemEntries, ...codexEntries, ...latencyEntries, ...claudeEntries].sort(
      (a, b) => a.ts - b.ts
    );
    const limited = merged.slice(-16);
    if (!selected && limited.length > 0) {
      setSelected(limited[limited.length - 1]);
    }
    return limited;
  }, [events]);

  const watcherLeaderboard = useMemo(() => {
    const map = new Map<
      string,
      {
        name: string;
        sampleCount: number;
        totalCpu: number;
        lastSeen: number;
        mem?: number;
      }
    >();

    events.processStats.forEach((entry) => {
      (entry.watchers ?? []).forEach((watcher) => {
        const name = watcher.name ?? "unknown";
        const key = name.toLowerCase();
        const record = map.get(key) ?? {
          name,
          sampleCount: 0,
          totalCpu: 0,
          lastSeen: 0,
          mem: watcher.mem,
        };
        record.sampleCount += 1;
        if (typeof watcher.cpu === "number") {
          record.totalCpu += watcher.cpu;
        }
        record.lastSeen = Math.max(record.lastSeen, entry.ts ?? 0);
        if (typeof watcher.mem === "number") {
          record.mem = watcher.mem;
        }
        map.set(key, record);
      });
    });

    return Array.from(map.values())
      .map((item) => ({
        ...item,
        avgCpu: item.totalCpu / item.sampleCount,
      }))
      .sort((a, b) => b.avgCpu - a.avgCpu)
      .slice(0, 6);
  }, [events.processStats]);

  const selectedWatchers = useMemo(() => {
    if (!selected) return [];
    return (
      events.processStats.find((entry) => entry.ts === selected.ts)?.watchers ??
      []
    );
  }, [events.processStats, selected]);

  const latest = events.systemMetrics.at(-1);
  const latestLatency = events.latencyEvents.at(-1);
  const memPercent = latest?.memTotalMb
    ? ((latest.memUsedMb ?? 0) / latest.memTotalMb) * 100
    : 0;

  // Get latest Claude Code API request for real latency
  const latestClaudeApi = events.claudeEvents
    .filter((e) => e.event === "api_request" && e.duration_ms)
    .at(-1);
  
  // Calculate average Claude API latency from recent requests
  const claudeApiStats = useMemo(() => {
    const apiRequests = events.claudeEvents.filter(
      (e) => e.event === "api_request" && typeof e.duration_ms === "number"
    );
    if (apiRequests.length === 0) return null;
    
    const durations = apiRequests.map((e) => e.duration_ms!);
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    const max = Math.max(...durations);
    const count = apiRequests.length;
    
    return { avg, max, count, latest: durations.at(-1) };
  }, [events.claudeEvents]);

  // Diagnostic: analyze all sources and identify probable cause
  const diagnostic = useMemo(() => {
    type SourceStatus = {
      id: string;
      name: string;
      icon: "cpu" | "memory" | "disk" | "network" | "api" | "server" | "terminal";
      status: "ok" | "warning" | "error" | "unknown";
      value: string;
      detail: string;
      score: number; // Higher = more likely to be the cause
      refreshMs: number; // Refresh interval in ms
      lastUpdate: number | null; // Timestamp of last update
    };

    const sources: SourceStatus[] = [];
    const hasData = events.systemMetrics.length > 0;
    const hasLatencyData = events.latencyEvents.length > 0;
    const systemLastUpdate = latest?.ts ?? null;
    const latencyLastUpdate = latestLatency?.ts ?? null;
    const claudeLastUpdate = events.claudeEvents.at(-1)?.ts ?? null;

    // CPU
    const cpuLoad = latest?.cpuLoad ?? 0;
    sources.push({
      id: "cpu",
      name: "CPU",
      icon: "cpu",
      status: !hasData ? "unknown" : cpuLoad > 80 ? "error" : cpuLoad > 60 ? "warning" : "ok",
      value: hasData ? `${cpuLoad.toFixed(0)}%` : "—",
      detail: hasData ? `User: ${latest?.cpuUser?.toFixed(0) ?? 0}% · System: ${latest?.cpuSystem?.toFixed(0) ?? 0}%` : "En attente de données",
      score: cpuLoad > 80 ? 90 : cpuLoad > 60 ? 50 : 0,
      refreshMs: 2000,
      lastUpdate: systemLastUpdate,
    });

    // Memory
    sources.push({
      id: "memory",
      name: "Mémoire RAM",
      icon: "memory",
      status: !hasData ? "unknown" : memPercent > 90 ? "error" : memPercent > 75 ? "warning" : "ok",
      value: hasData ? `${memPercent.toFixed(0)}%` : "—",
      detail: hasData ? `${((latest?.memUsedMb ?? 0) / 1024).toFixed(1)} / ${((latest?.memTotalMb ?? 0) / 1024).toFixed(0)} GB` : "En attente de données",
      score: memPercent > 90 ? 85 : memPercent > 75 ? 40 : 0,
      refreshMs: 2000,
      lastUpdate: systemLastUpdate,
    });

    // Swap
    const swapUsed = latest?.swapUsedMb ?? 0;
    sources.push({
      id: "swap",
      name: "Swap",
      icon: "memory",
      status: !hasData ? "unknown" : swapUsed > 4000 ? "error" : swapUsed > 1000 ? "warning" : "ok",
      value: hasData ? `${(swapUsed / 1024).toFixed(1)} GB` : "—",
      detail: swapUsed > 1000 ? "Swap actif = RAM insuffisante" : "Normal",
      score: swapUsed > 4000 ? 80 : swapUsed > 1000 ? 35 : 0,
      refreshMs: 2000,
      lastUpdate: systemLastUpdate,
    });

    // Claude Code REAL API latency (from OTEL)
    const hasClaudeData = events.claudeEvents.length > 0;
    const claudeLatency = claudeApiStats?.latest;
    sources.push({
      id: "claude-api",
      name: "Claude Code (réel)",
      icon: "terminal",
      status: !hasClaudeData ? "unknown" : (claudeLatency ?? 0) > 10000 ? "error" : (claudeLatency ?? 0) > 5000 ? "warning" : "ok",
      value: claudeLatency ? `${Math.round(claudeLatency)}ms` : "—",
      detail: hasClaudeData 
        ? claudeApiStats 
          ? `Moy: ${Math.round(claudeApiStats.avg)}ms · Max: ${Math.round(claudeApiStats.max)}ms`
          : "Aucune requête API"
        : "Active OTEL pour Claude Code",
      score: (claudeLatency ?? 0) > 10000 ? 95 : (claudeLatency ?? 0) > 5000 ? 70 : 0,
      refreshMs: 5000, // Events arrive in real-time, but UI polls every 5s
      lastUpdate: claudeLastUpdate,
    });

    // Top CPU consumer process
    const topProcess = watcherLeaderboard[0];
    if (topProcess && topProcess.avgCpu > 20) {
      sources.push({
        id: "process",
        name: `Process: ${topProcess.name}`,
        icon: "terminal",
        status: topProcess.avgCpu > 50 ? "error" : topProcess.avgCpu > 30 ? "warning" : "ok",
        value: `${topProcess.avgCpu.toFixed(0)}% CPU`,
        detail: `${topProcess.mem?.toFixed(0) ?? "—"} MB RAM`,
        score: topProcess.avgCpu > 50 ? 75 : topProcess.avgCpu > 30 ? 45 : 0,
        refreshMs: 2000,
        lastUpdate: systemLastUpdate,
      });
    }

    // Network throughput (low = potential issue)
    const networkRx = latest?.networkRxPerSec ?? 0;
    const networkTx = latest?.networkTxPerSec ?? 0;
    sources.push({
      id: "network",
      name: "Réseau",
      icon: "network",
      status: !hasData ? "unknown" : "ok",
      value: hasData ? formatBps(networkRx + networkTx) : "—",
      detail: `↓ ${formatBps(networkRx)} · ↑ ${formatBps(networkTx)}`,
      score: 0, // Network itself is rarely the direct cause
      refreshMs: 2000,
      lastUpdate: systemLastUpdate,
    });

    // Find probable cause
    const sortedByScore = [...sources].sort((a, b) => b.score - a.score);
    const topIssue = sortedByScore[0];
    
    let summary = "";
    let summaryStatus: "ok" | "warning" | "error" = "ok";

    if (!hasData && !hasLatencyData) {
      summary = "En attente de données... Active le monitoring.";
      summaryStatus = "warning";
    } else if (topIssue.score >= 80) {
      summary = `Cause probable : ${topIssue.name} (${topIssue.value})`;
      summaryStatus = "error";
    } else if (topIssue.score >= 40) {
      summary = `Attention : ${topIssue.name} montre des signes de stress`;
      summaryStatus = "warning";
    } else {
      summary = "Tout semble normal. Si ça rame, c'est peut-être le modèle IA lui-même.";
      summaryStatus = "ok";
    }

    return { sources, summary, summaryStatus, topIssue };
  }, [latest, latestLatency, memPercent, watcherLeaderboard, events.systemMetrics.length, events.latencyEvents.length, events.claudeEvents.length, claudeApiStats]);

  return (
    <div className="min-h-screen p-4 md:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        {/* Header */}
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Activity className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight">AI Pulse</h1>
                <p className="text-sm text-muted-foreground">
                  Monitoring temps réel · Claude, Codex, Cursor
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <Badge
              variant={watchingState.enabled ? "success" : "secondary"}
              className="gap-1.5"
            >
              {watchingState.enabled ? (
                <Eye className="h-3 w-3" />
              ) : (
                <EyeOff className="h-3 w-3" />
              )}
              {watchingState.enabled ? "Live" : "Paused"}
            </Badge>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Watchers</span>
              <Switch
                checked={watchingState.enabled}
                onCheckedChange={toggleWatching}
                disabled={loadingToggle}
              />
            </div>
          </div>
        </header>

        {/* Diagnostic Panel */}
        <Card className={cn(
          "border-2",
          diagnostic.summaryStatus === "error" 
            ? "border-red-500/50 bg-red-500/5" 
            : diagnostic.summaryStatus === "warning"
              ? "border-amber-500/50 bg-amber-500/5"
              : "border-green-500/50 bg-green-500/5"
        )}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {diagnostic.summaryStatus === "error" ? (
                  <AlertTriangle className="h-5 w-5 text-red-400" />
                ) : diagnostic.summaryStatus === "warning" ? (
                  <AlertTriangle className="h-5 w-5 text-amber-400" />
                ) : (
                  <CheckCircle2 className="h-5 w-5 text-green-400" />
                )}
                <div>
                  <CardTitle className="text-base font-medium">Diagnostic</CardTitle>
                  <p className={cn(
                    "text-sm font-medium",
                    diagnostic.summaryStatus === "error" 
                      ? "text-red-400" 
                      : diagnostic.summaryStatus === "warning"
                        ? "text-amber-400"
                        : "text-green-400"
                  )}>
                    {diagnostic.summary}
                  </p>
                </div>
              </div>
              <Badge variant={
                diagnostic.summaryStatus === "error" 
                  ? "destructive" 
                  : diagnostic.summaryStatus === "warning"
                    ? "warning"
                    : "success"
              }>
                {diagnostic.sources.filter(s => s.status === "error").length} erreurs · {diagnostic.sources.filter(s => s.status === "warning").length} alertes
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {diagnostic.sources.map((source) => (
                <div
                  key={source.id}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border p-3",
                    source.status === "error"
                      ? "border-red-500/30 bg-red-500/10"
                      : source.status === "warning"
                        ? "border-amber-500/30 bg-amber-500/10"
                        : source.status === "ok"
                          ? "border-green-500/30 bg-green-500/10"
                          : "border-border bg-secondary/30"
                  )}
                >
                  <div className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                    source.status === "error"
                      ? "bg-red-500/20 text-red-400"
                      : source.status === "warning"
                        ? "bg-amber-500/20 text-amber-400"
                        : source.status === "ok"
                          ? "bg-green-500/20 text-green-400"
                          : "bg-muted text-muted-foreground"
                  )}>
                    {source.icon === "cpu" && <Cpu className="h-4 w-4" />}
                    {source.icon === "memory" && <MemoryStick className="h-4 w-4" />}
                    {source.icon === "disk" && <HardDrive className="h-4 w-4" />}
                    {source.icon === "network" && <Network className="h-4 w-4" />}
                    {source.icon === "api" && <Globe className="h-4 w-4" />}
                    {source.icon === "server" && <Server className="h-4 w-4" />}
                    {source.icon === "terminal" && <Terminal className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium">{source.name}</p>
                      <div className="flex items-center gap-1.5">
                        <span className={cn(
                          "shrink-0 text-sm font-bold",
                          source.status === "error"
                            ? "text-red-400"
                            : source.status === "warning"
                              ? "text-amber-400"
                              : source.status === "ok"
                                ? "text-green-400"
                                : "text-muted-foreground"
                        )}>
                          {source.value}
                        </span>
                        <CountdownTimer
                          refreshMs={source.refreshMs}
                          lastUpdate={source.lastUpdate}
                          size={14}
                          className={cn(
                            source.status === "error"
                              ? "text-red-400"
                              : source.status === "warning"
                                ? "text-amber-400"
                                : source.status === "ok"
                                  ? "text-green-400"
                                  : "text-muted-foreground"
                          )}
                        />
                      </div>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{source.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Metrics Cards */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <MetricCard
            title="CPU"
            value={`${latest?.cpuLoad?.toFixed(1) ?? "—"}%`}
            subtitle={`User: ${latest?.cpuUser?.toFixed(0) ?? "—"}% · System: ${latest?.cpuSystem?.toFixed(0) ?? "—"}%`}
            icon={<Cpu className="h-4 w-4" />}
            trend={latest?.cpuLoad && latest.cpuLoad > 70 ? "warning" : "normal"}
          />
          <MetricCard
            title="Mémoire"
            value={`${((latest?.memUsedMb ?? 0) / 1024).toFixed(1)} GB`}
            subtitle={`${memPercent.toFixed(0)}% utilisé`}
            icon={<MemoryStick className="h-4 w-4" />}
            trend={memPercent > 80 ? "warning" : "normal"}
          />
          <MetricCard
            title="Disque I/O"
            value={`${latest?.diskReadCnt ?? 0}`}
            subtitle={`Read: ${latest?.diskReadCnt ?? 0} · Write: ${latest?.diskWriteCnt ?? 0}`}
            icon={<HardDrive className="h-4 w-4" />}
          />
          <MetricCard
            title="Réseau"
            value={formatBps(latest?.networkRxPerSec ?? 0)}
            subtitle={`↓ ${formatBps(latest?.networkRxPerSec ?? 0)} · ↑ ${formatBps(latest?.networkTxPerSec ?? 0)}`}
            icon={<Network className="h-4 w-4" />}
          />
          <MetricCard
            title="Claude Code API"
            value={claudeApiStats?.latest ? `${Math.round(claudeApiStats.latest)}ms` : "—"}
            subtitle={claudeApiStats ? `Moy: ${Math.round(claudeApiStats.avg)}ms · ${claudeApiStats.count} req` : "Aucune donnée OTEL"}
            icon={<Bot className="h-4 w-4" />}
            trend={
              (claudeApiStats?.latest ?? 0) > 5000
                ? "warning"
                : "normal"
            }
          />
        </div>

        {/* Timeline */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-medium">
                Timeline unifiée
              </CardTitle>
              <span className="text-xs text-muted-foreground">
                {timeline.length} événements · Mise à jour{" "}
                {formatTimestamp(latest?.ts)}
              </span>
            </div>
          </CardHeader>
          <CardContent>
            <ScrollArea className="w-full whitespace-nowrap">
              <div className="flex gap-2 pb-3">
                {timeline.map((entry) => (
                  <button
                    key={`${entry.kind}-${entry.ts}`}
                    onClick={() => setSelected(entry)}
                    className={cn(
                      "flex min-w-[100px] flex-col items-center gap-1 rounded-lg border p-3 transition-all hover:bg-accent",
                      selected?.ts === entry.ts
                        ? "border-primary bg-primary/5"
                        : "border-border"
                    )}
                  >
                    <div
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-full",
                        entry.kind === "system"
                          ? "bg-blue-500/10 text-blue-400"
                          : entry.kind === "latency"
                            ? "bg-green-500/10 text-green-400"
                            : entry.kind === "claude"
                              ? "bg-orange-500/10 text-orange-400"
                              : "bg-purple-500/10 text-purple-400"
                      )}
                    >
                      {entry.kind === "system" ? (
                        <Cpu className="h-4 w-4" />
                      ) : entry.kind === "latency" ? (
                        <Globe className="h-4 w-4" />
                      ) : entry.kind === "claude" ? (
                        <Bot className="h-4 w-4" />
                      ) : (
                        <Zap className="h-4 w-4" />
                      )}
                    </div>
                    <span className="text-sm font-medium">{entry.label}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {formatTimestamp(entry.ts)}
                    </span>
                  </button>
                ))}
              </div>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Main Grid */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Watcher Leaderboard */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-medium">
                Processus surveillés
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {watcherLeaderboard.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Aucun watcher observé pour le moment.
                </p>
              ) : (
                watcherLeaderboard.map((watcher, i) => (
                  <div
                    key={watcher.name}
                    className="flex items-center justify-between rounded-lg bg-secondary/50 px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                        {i + 1}
                      </span>
                      <div>
                        <p className="font-medium">{watcher.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {watcher.sampleCount} échantillons
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-mono text-sm font-medium text-primary">
                        {watcher.avgCpu.toFixed(1)}%
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {watcher.mem ? `${watcher.mem.toFixed(0)} MB` : "—"}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* Selected Event Details */}
          <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
            <CardHeader>
              <CardTitle className="text-base font-medium">
                Détail de l'événement
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {selected ? (
                <>
                  <div className="rounded-lg bg-background/50 p-4">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Source
                    </p>
                    <p className="mt-1 text-lg font-medium">
                      {selected.kind === "system"
                        ? "Sondes système"
                        : selected.kind === "latency"
                          ? "Latence réseau"
                          : selected.kind === "claude"
                            ? `Claude: ${(selected.data as ClaudeEventRecord).event}`
                            : selected.label}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {selected.kind === "system"
                        ? `${(selected.data.cpuLoad ?? 0).toFixed(1)}% CPU · ${selected.data.watcherCount ?? 0} watchers`
                        : selected.kind === "latency"
                          ? `Anthropic: ${selected.data.anthropicMs ?? "—"}ms · OpenAI: ${selected.data.openaiMs ?? "—"}ms`
                          : selected.kind === "claude"
                            ? `${(selected.data as ClaudeEventRecord).duration_ms ?? "—"}ms${(selected.data as ClaudeEventRecord).model ? ` · ${(selected.data as ClaudeEventRecord).model}` : ""}`
                            : `${String((selected.data as CodexEventRecord).note ?? (selected.data as CodexEventRecord).raw ?? "—").slice(0, 64)}`}
                    </p>
                  </div>

                  {selected.kind === "latency" && (
                    <div className="rounded-lg bg-background/50 p-4">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">
                        Détail des endpoints
                      </p>
                      <div className="mt-2 space-y-2">
                        {(selected.data as LatencyEventRecord).endpoints.map((endpoint) => (
                          <div
                            key={endpoint.name}
                            className="flex items-center justify-between text-sm"
                          >
                            <span className="font-mono text-xs text-muted-foreground">
                              {endpoint.name}
                            </span>
                            <span
                              className={cn(
                                "font-medium",
                                endpoint.error
                                  ? "text-red-400"
                                  : (endpoint.latencyMs ?? 0) > 500
                                    ? "text-amber-400"
                                    : "text-green-400"
                              )}
                            >
                              {endpoint.error
                                ? endpoint.error
                                : `${endpoint.latencyMs}ms`}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {selected.kind === "claude" && (
                    <div className="rounded-lg bg-background/50 p-4">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">
                        Détail Claude Code
                      </p>
                      <div className="mt-2 space-y-2">
                        {(selected.data as ClaudeEventRecord).duration_ms && (
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">Durée</span>
                            <span className={cn(
                              "font-mono font-bold",
                              (selected.data as ClaudeEventRecord).duration_ms! > 5000
                                ? "text-amber-400"
                                : "text-green-400"
                            )}>
                              {(selected.data as ClaudeEventRecord).duration_ms}ms
                            </span>
                          </div>
                        )}
                        {(selected.data as ClaudeEventRecord).model && (
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">Modèle</span>
                            <span className="font-mono">{(selected.data as ClaudeEventRecord).model}</span>
                          </div>
                        )}
                        {(selected.data as ClaudeEventRecord).tool_name && (
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">Tool</span>
                            <span className="font-mono">{(selected.data as ClaudeEventRecord).tool_name}</span>
                          </div>
                        )}
                        {(selected.data as ClaudeEventRecord).input_tokens && (
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">Tokens</span>
                            <span className="font-mono">
                              {(selected.data as ClaudeEventRecord).input_tokens} in / {(selected.data as ClaudeEventRecord).output_tokens ?? 0} out
                            </span>
                          </div>
                        )}
                        {(selected.data as ClaudeEventRecord).cost_usd && (
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">Coût</span>
                            <span className="font-mono">${(selected.data as ClaudeEventRecord).cost_usd?.toFixed(4)}</span>
                          </div>
                        )}
                        {(selected.data as ClaudeEventRecord).error && (
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">Erreur</span>
                            <span className="font-mono text-red-400">{(selected.data as ClaudeEventRecord).error}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="rounded-lg bg-background/50 p-4">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Processus actifs
                    </p>
                    <div className="mt-2 space-y-2">
                      {selectedWatchers.length > 0 ? (
                        selectedWatchers.map((proc) => (
                          <div
                            key={`${proc.name ?? "proc"}-${proc.pid ?? Math.random()}`}
                            className="flex items-center justify-between text-sm"
                          >
                            <span className="font-mono text-xs text-muted-foreground">
                              {proc.name ?? "process"}
                            </span>
                            <span className="font-medium">
                              {(proc.cpu ?? 0).toFixed(1)}% ·{" "}
                              {(proc.mem ?? 0).toFixed(0)} MB
                            </span>
                          </div>
                        ))
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          Aucun process lié
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="rounded-lg bg-background/50 p-4">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Timestamp
                    </p>
                    <p className="mt-1 font-mono text-sm">
                      {new Date(selected.ts).toLocaleString()}
                    </p>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Sélectionnez un événement dans la timeline
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  title,
  value,
  subtitle,
  icon,
  trend = "normal",
}: {
  title: string;
  value: string;
  subtitle: string;
  icon: React.ReactNode;
  trend?: "normal" | "warning";
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{title}</span>
          <div
            className={cn(
              "rounded-md p-1.5",
              trend === "warning"
                ? "bg-amber-500/10 text-amber-400"
                : "bg-primary/10 text-primary"
            )}
          >
            {icon}
          </div>
        </div>
        <div className="mt-2">
          <span
            className={cn(
              "text-2xl font-bold",
              trend === "warning" && "text-amber-400"
            )}
          >
            {value}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
      </CardContent>
    </Card>
  );
}

function formatBps(bytesPerSec: number) {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
}

/**
 * Filled pie chart countdown - empties as time passes (like a camembert)
 * Only shown for refresh intervals > 10 seconds
 */
function CountdownTimer({
  refreshMs,
  lastUpdate,
  size = 14,
  className,
}: {
  refreshMs: number;
  lastUpdate: number | null;
  size?: number;
  className?: string;
}) {
  const [remaining, setRemaining] = useState(100);

  useEffect(() => {
    if (!lastUpdate) {
      setRemaining(0);
      return;
    }

    const updateRemaining = () => {
      const elapsed = Date.now() - lastUpdate;
      const pct = Math.max(0, 100 - (elapsed / refreshMs) * 100);
      setRemaining(pct);
    };

    updateRemaining();
    const interval = setInterval(updateRemaining, 100);
    return () => clearInterval(interval);
  }, [lastUpdate, refreshMs]);

  // Only show for intervals > 10 seconds
  if (refreshMs <= 10000) {
    return null;
  }

  // Pie chart path calculation
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 1;
  
  // Convert percentage to angle (0% = 0°, 100% = 360°)
  const angle = (remaining / 100) * 360;
  const radians = (angle - 90) * (Math.PI / 180); // Start from top (-90°)
  
  // Calculate end point of arc
  const x = cx + radius * Math.cos(radians);
  const y = cy + radius * Math.sin(radians);
  
  // Large arc flag (1 if angle > 180°)
  const largeArc = angle > 180 ? 1 : 0;

  // Create pie slice path
  const path = remaining >= 100
    ? `M ${cx} ${cy} m 0 -${radius} a ${radius} ${radius} 0 1 1 0 ${radius * 2} a ${radius} ${radius} 0 1 1 0 -${radius * 2}`
    : remaining <= 0
      ? ""
      : `M ${cx} ${cy} L ${cx} ${cy - radius} A ${radius} ${radius} 0 ${largeArc} 1 ${x} ${y} Z`;

  return (
    <svg
      width={size}
      height={size}
      className={cn("shrink-0", className)}
    >
      {/* Background circle */}
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        fill="currentColor"
        className="opacity-20"
      />
      {/* Filled pie slice (empties over time) */}
      {remaining > 0 && (
        <path
          d={path}
          fill="currentColor"
          className="transition-all duration-100"
        />
      )}
    </svg>
  );
}
