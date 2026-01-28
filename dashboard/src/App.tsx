import { useEffect, useMemo, useState } from "react";
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
  Info,
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
import {
  ChartContainer,
  ChartTooltip,
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
} from "@/components/ui/chart";
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

// Claude Code local events (from claude-local-collector)
type ClaudeLocalEventRecord = {
  ts: number;
  source: "local";
  event: "session_snapshot" | "daily_stats" | "task_status";
  sessionId?: string;
  messageCount?: number;
  toolCallCount?: number;
  messageToolRatio?: number;
  durationMinutes?: number;
  project?: string;
  date?: string;
  sessionCount?: number;
  totalSessions?: number;
  totalMessages?: number;
  pendingCount?: number;
  blockedCount?: number;
  tasks?: Array<{ id: string; subject: string; status: string }>;
  patterns?: Record<string, string | { severity: string; sessionId?: string; project?: string; durationMinutes?: number; ratio?: string; count?: number }>;
};

// Codex local events (from codex-local-collector)
type CodexLocalEventRecord = {
  ts: number;
  source: "local";
  agent: "codex";
  event: "session_snapshot" | "session_file" | "daily_stats";
  sessionId?: string;
  promptCount?: number;
  messageCount?: number;
  toolCount?: number;
  durationMinutes?: number;
  cliVersion?: string;
  model?: string;
  date?: string;
  sessionCount?: number;
  patterns?: Record<string, string | { severity: string; sessionId?: string; project?: string; durationMinutes?: number }>;
};

// Monitoring mode
type MonitoringMode = "active" | "passive";

// Metric explanations for tooltips
const METRIC_EXPLANATIONS: Record<string, {
  what: string;
  warning?: {
    problem: string;
    implications: string;
    causes: string[];
  };
  error?: {
    problem: string;
    implications: string;
    causes: string[];
  };
}> = {
  cpu: {
    what: "Le pourcentage de puissance de calcul utilisée par ton Mac.",
    warning: {
      problem: "Le CPU est sollicité à plus de 60%.",
      implications: "Les applications peuvent ralentir, Claude Code peut mettre plus de temps à répondre.",
      causes: [
        "Un agent Claude fait des calculs intensifs",
        "Un build/compilation en cours",
        "Trop d'applications ouvertes",
        "Spotlight indexe des fichiers"
      ]
    },
    error: {
      problem: "Le CPU est saturé (>80%).",
      implications: "Tout va ramer. Les réponses de Claude seront très lentes.",
      causes: [
        "Plusieurs agents Claude tournent en parallèle",
        "Une boucle infinie dans un script",
        "Un process est bloqué ou planté"
      ]
    }
  },
  memory: {
    what: "La RAM utilisée par toutes les applications.",
    warning: {
      problem: "Plus de 75% de la RAM est utilisée.",
      implications: "macOS va commencer à utiliser le swap (disque), ce qui ralentit tout.",
      causes: [
        "Sessions Claude avec beaucoup de contexte",
        "Navigateur avec beaucoup d'onglets",
        "Applications gourmandes (Xcode, Docker)"
      ]
    },
    error: {
      problem: "Mémoire quasi-saturée (>90%).",
      implications: "Le Mac va fortement ralentir. Des apps peuvent planter.",
      causes: [
        "Fuite mémoire dans une app",
        "Trop de sessions Claude actives",
        "Besoin de fermer des applications"
      ]
    }
  },
  swap: {
    what: "Espace disque utilisé comme extension de la RAM (plus lent).",
    warning: {
      problem: "Le Mac utilise plus de 1GB de swap.",
      implications: "Accès mémoire plus lents, possible ralentissement général.",
      causes: ["RAM insuffisante pour la charge actuelle"]
    },
    error: {
      problem: "Swap très élevé (>4GB).",
      implications: "Performances dégradées. Le disque travaille beaucoup.",
      causes: ["RAM saturée depuis un moment", "Besoin de redémarrer ou fermer des apps"]
    }
  },
  "claude-api": {
    what: "Le temps de réponse réel de l'API Claude (mesuré via OTEL).",
    warning: {
      problem: "Réponses de l'API >5 secondes.",
      implications: "Claude prend du temps à répondre. Normal pour les gros prompts.",
      causes: [
        "Prompt avec beaucoup de contexte",
        "Charge sur les serveurs Anthropic",
        "Connexion réseau lente"
      ]
    },
    error: {
      problem: "Réponses >10 secondes.",
      implications: "L'API est très lente. Tes interactions avec Claude seront frustrantes.",
      causes: [
        "Serveurs Anthropic surchargés",
        "Contexte énorme dans la conversation",
        "Problème réseau"
      ]
    }
  },
  "local-ratio": {
    what: "Nombre de messages par rapport aux appels d'outils (actions).",
    warning: {
      problem: "Ratio >7 : Claude parle beaucoup mais agit peu.",
      implications: "L'agent pourrait tourner en rond ou être bloqué.",
      causes: [
        "Claude demande des clarifications en boucle",
        "Tâche mal définie",
        "Blocage sur une permission"
      ]
    },
    error: {
      problem: "Ratio >10 : Très peu d'actions par rapport aux messages.",
      implications: "Session probablement improductive. Claude ne fait rien de concret.",
      causes: [
        "Agent bloqué",
        "Conversation qui tourne en rond",
        "Besoin de reformuler la demande"
      ]
    }
  },
  "local-session": {
    what: "Durée de la session Claude Code active.",
    warning: {
      problem: "Session active depuis plus de 4 heures.",
      implications: "Le contexte s'accumule, les réponses peuvent devenir moins pertinentes.",
      causes: ["Session longue sans interruption"]
    },
    error: {
      problem: "Session de plus de 8 heures.",
      implications: "Contexte très chargé. Risque de compaction ou d'oublis.",
      causes: ["Tu devrais relancer une nouvelle session"]
    }
  },
  network: {
    what: "Débit réseau entrant et sortant de ton Mac.",
    warning: {
      problem: "Le réseau est utilisé intensivement.",
      implications: "Possible ralentissement des requêtes API ou téléchargements.",
      causes: ["Téléchargement en cours", "Sync cloud (iCloud, Dropbox)", "Mise à jour en arrière-plan"]
    }
  },
  process: {
    what: "Un processus qui consomme beaucoup de CPU.",
    warning: {
      problem: "Ce processus utilise plus de 30% du CPU.",
      implications: "Il peut ralentir les autres applications.",
      causes: ["Compilation en cours", "Process gourmand", "Possible fuite CPU"]
    },
    error: {
      problem: "Ce processus monopolise le CPU (>50%).",
      implications: "Les autres apps seront très lentes.",
      causes: ["Process bloqué ou en boucle", "Tâche intensive", "Envisage de le tuer si bloqué"]
    }
  },
  "claude-local": {
    what: "Données locales de Claude Code lues depuis ~/.claude/ (sessions, stats, tâches).",
    warning: {
      problem: "Un des indicateurs locaux est en warning (ratio, session, ou tâches).",
      implications: "Vérifie les détails dans le tooltip pour identifier le problème.",
      causes: [
        "Session longue (>4h) → envisage de relancer",
        "Ratio msg/tool élevé (>7) → agent peut-être bloqué",
        "Tâches bloquées (>2) → dépendances non résolues"
      ]
    },
    error: {
      problem: "Un des indicateurs locaux est en erreur.",
      implications: "Action recommandée selon l'indicateur concerné.",
      causes: [
        "Session très longue (>8h) → relance la session",
        "Ratio msg/tool très élevé (>10) → reformule ta demande",
        "Beaucoup de tâches bloquées (>5) → nettoie avec /tasks"
      ]
    }
  },
  "codex-local": {
    what: "Statistiques locales de Codex CLI lues depuis ~/.codex/.",
    warning: {
      problem: "Beaucoup d'activité Codex.",
      implications: "Normal si tu utilises activement Codex.",
      causes: ["Utilisation intensive de Codex"]
    }
  },
  "local-tasks": {
    what: "Tâches créées par Claude Code (via TaskCreate) stockées dans ~/.claude/tasks/. Ce sont les tâches du panneau latéral que Claude utilise pour suivre son travail.",
    warning: {
      problem: "Des tâches sont marquées 'pending' ou 'in_progress' depuis un moment.",
      implications: "Claude a peut-être oublié des tâches ou une session précédente a laissé des tâches non terminées.",
      causes: [
        "Session Claude interrompue avant de finir",
        "Tâches créées mais jamais complétées",
        "Tu peux les voir avec /tasks dans Claude Code"
      ]
    },
    error: {
      problem: "Beaucoup de tâches non complétées.",
      implications: "Accumulation de travail planifié mais non fait.",
      causes: [
        "Nettoie avec /tasks puis supprime celles obsolètes",
        "Ou ignore si ce sont de vieilles sessions"
      ]
    }
  }
};

type EventsPayload = {
  systemMetrics: SystemMetricsRecord[];
  processStats: ProcessStatsRecord[];
  codexEvents: CodexEventRecord[];
  codexLocalEvents: CodexLocalEventRecord[];
  latencyEvents: LatencyEventRecord[];
  claudeEvents: ClaudeEventRecord[];
  claudeLocalEvents: ClaudeLocalEventRecord[];
  mode: MonitoringMode;
};

type TimelineEntry =
  | { kind: "system"; ts: number; label: string; data: SystemMetricsRecord }
  | { kind: "codex"; ts: number; label: string; data: CodexEventRecord }
  | { kind: "codex-local"; ts: number; label: string; data: CodexLocalEventRecord }
  | { kind: "latency"; ts: number; label: string; data: LatencyEventRecord }
  | { kind: "claude"; ts: number; label: string; data: ClaudeEventRecord }
  | { kind: "local"; ts: number; label: string; data: ClaudeLocalEventRecord };

type SourceStatus = {
  id: string;
  name: string;
  icon: "cpu" | "memory" | "disk" | "network" | "api" | "server" | "terminal";
  status: "ok" | "warning" | "error" | "unknown";
  value: string;
  detail: string;
  details?: Array<{ label: string; value: string; status?: "ok" | "warning" | "error" }>; // Extra details for tooltip
  score: number;
  refreshMs: number;
  lastUpdate: number | null;
};

export default function App() {
  const [events, setEvents] = useState<EventsPayload>({
    systemMetrics: [],
    processStats: [],
    codexEvents: [],
    codexLocalEvents: [],
    latencyEvents: [],
    claudeEvents: [],
    claudeLocalEvents: [],
    mode: "passive",
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

    // Claude local events (session snapshots, daily stats)
    const localEntries = events.claudeLocalEvents
      .filter((e) => e.event === "session_snapshot" || e.event === "daily_stats")
      .slice(-10)
      .map((event) => ({
        kind: "local" as const,
        ts: event.ts,
        label: event.event === "session_snapshot"
          ? `${event.messageCount ?? 0} msgs`
          : `${event.messageToolRatio?.toFixed(1) ?? "—"} ratio`,
        data: event,
      }));

    // Codex local events
    const codexLocalEntries = events.codexLocalEvents
      .filter((e) => e.event === "session_snapshot" || e.event === "daily_stats")
      .slice(-10)
      .map((event) => ({
        kind: "codex-local" as const,
        ts: event.ts,
        label: event.event === "session_snapshot"
          ? `${event.promptCount ?? 0} prompts`
          : `${event.sessionCount ?? 0} sess`,
        data: event,
      }));

    const merged = [...systemEntries, ...codexEntries, ...latencyEntries, ...claudeEntries, ...localEntries, ...codexLocalEntries].sort(
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

    // Network (4th card - always shown)
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

    // Claude Local stats (merged card from local collector)
    const latestLocalStats = events.claudeLocalEvents
      .filter((e) => e.event === "daily_stats")
      .at(-1);
    const latestSession = events.claudeLocalEvents
      .filter((e) => e.event === "session_snapshot")
      .at(-1);
    const latestTaskStatus = events.claudeLocalEvents
      .filter((e) => e.event === "task_status")
      .at(-1);
    const hasLocalData = events.claudeLocalEvents.length > 0;
    const localLastUpdate = events.claudeLocalEvents.at(-1)?.ts ?? null;

    if (hasLocalData) {
      // Calculate individual statuses
      const ratio = latestLocalStats?.messageToolRatio ?? 0;
      const ratioStatus: "ok" | "warning" | "error" = ratio > 10 ? "error" : ratio > 7 ? "warning" : "ok";

      const durationMin = latestSession?.durationMinutes ?? 0;
      const sessionStatus: "ok" | "warning" | "error" = durationMin > 480 ? "error" : durationMin > 240 ? "warning" : "ok";

      const blocked = latestTaskStatus?.blockedCount ?? 0;
      const pending = latestTaskStatus?.pendingCount ?? 0;
      const tasksStatus: "ok" | "warning" | "error" = blocked > 5 ? "error" : blocked > 2 ? "warning" : "ok";

      // Merge status: worst wins
      const statuses = [ratioStatus, sessionStatus, tasksStatus];
      const mergedStatus: "ok" | "warning" | "error" = statuses.includes("error") ? "error" : statuses.includes("warning") ? "warning" : "ok";

      // Calculate score (max of all)
      const scores = [
        ratio > 10 ? 85 : ratio > 7 ? 55 : 0,
        durationMin > 480 ? 70 : durationMin > 240 ? 40 : 0,
        blocked > 5 ? 70 : blocked > 2 ? 35 : 0,
      ];
      const maxScore = Math.max(...scores);

      // Build details array for tooltip
      const details: Array<{ label: string; value: string; status?: "ok" | "warning" | "error" }> = [];

      if (latestLocalStats) {
        details.push({
          label: "Ratio Msg/Tool",
          value: `${ratio.toFixed(1)} (${latestLocalStats.messageCount ?? 0} msgs / ${latestLocalStats.toolCallCount ?? 0} tools)`,
          status: ratioStatus,
        });
      }

      if (latestSession && durationMin > 0) {
        details.push({
          label: "Session",
          value: `${Math.floor(durationMin / 60)}h${durationMin % 60}m · ${latestSession.messageCount ?? 0} messages`,
          status: sessionStatus,
        });
      }

      if (latestTaskStatus && (pending > 0 || blocked > 0)) {
        details.push({
          label: "Tâches",
          value: `${pending} en attente · ${blocked} bloquées`,
          status: tasksStatus,
        });
      }

      // Main value: show most relevant info
      const mainValue = durationMin > 0
        ? `${Math.floor(durationMin / 60)}h${durationMin % 60}m`
        : ratio > 0
          ? `ratio ${ratio.toFixed(1)}`
          : "actif";

      sources.push({
        id: "claude-local",
        name: "Claude (Local)",
        icon: "terminal",
        status: mergedStatus,
        value: mainValue,
        detail: `${latestLocalStats?.messageCount ?? 0} msgs aujourd'hui`,
        details,
        score: maxScore,
        refreshMs: 30000,
        lastUpdate: localLastUpdate,
      });
    }

    // Codex local stats - check daily_stats, session_snapshot, or session_file
    const latestCodexStats = events.codexLocalEvents
      .filter((e) => e.event === "daily_stats")
      .at(-1);
    const latestCodexSnapshot = events.codexLocalEvents
      .filter((e) => e.event === "session_snapshot")
      .at(-1);
    const latestCodexFile = events.codexLocalEvents
      .filter((e) => e.event === "session_file")
      .at(-1);
    const hasCodexLocalData = events.codexLocalEvents.length > 0;
    const codexLocalLastUpdate = events.codexLocalEvents.at(-1)?.ts ?? null;

    // Show daily stats if available
    if (latestCodexStats) {
      sources.push({
        id: "codex-local",
        name: "Codex (Local)",
        icon: "terminal",
        status: "ok",
        value: `${latestCodexStats.promptCount ?? 0} prompts`,
        detail: `${latestCodexStats.sessionCount ?? 0} sessions aujourd'hui`,
        score: 0,
        refreshMs: 30000,
        lastUpdate: codexLocalLastUpdate,
      });
    } else if (hasCodexLocalData && latestCodexFile) {
      // Fallback to session file info
      sources.push({
        id: "codex-local",
        name: "Codex (Local)",
        icon: "terminal",
        status: "ok",
        value: `${latestCodexFile.messageCount ?? 0} msgs`,
        detail: `${latestCodexFile.toolCount ?? 0} tools · ${latestCodexFile.model ?? "—"}`,
        score: 0,
        refreshMs: 30000,
        lastUpdate: codexLocalLastUpdate,
      });
    }

    // Codex session info - check session_snapshot first, then session_file
    const codexSessionData = latestCodexSnapshot || latestCodexFile;

    if (codexSessionData) {
      const durationMin = codexSessionData.durationMinutes ?? 0;
      const hasValidDuration = durationMin > 0;

      if (hasValidDuration) {
        sources.push({
          id: "codex-session",
          name: "Codex Session",
          icon: "terminal",
          status: durationMin > 240 ? "error" : durationMin > 120 ? "warning" : "ok",
          value: `${Math.floor(durationMin / 60)}h${durationMin % 60}m`,
          detail: `${codexSessionData.promptCount ?? codexSessionData.messageCount ?? 0} prompts/msgs`,
          score: durationMin > 240 ? 60 : durationMin > 120 ? 30 : 0,
          refreshMs: 30000,
          lastUpdate: codexLocalLastUpdate,
        });
      }
    }

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
  }, [latest, latestLatency, memPercent, watcherLeaderboard, events.systemMetrics.length, events.latencyEvents.length, events.claudeEvents.length, events.claudeLocalEvents, events.codexLocalEvents, claudeApiStats]);

  // Get latest session and local stats for diagnostic
  const latestSession = events.claudeLocalEvents
    .filter((e) => e.event === "session_snapshot")
    .at(-1);
  const latestLocalStats = events.claudeLocalEvents
    .filter((e) => e.event === "daily_stats")
    .at(-1);

  // Collect all patterns from recent events for diagnostic
  const allPatterns = useMemo(() => {
    const patternList: Array<{ name: string; severity: string }> = [];
    for (const event of events.claudeLocalEvents.slice(-20)) {
      if (event.patterns) {
        for (const [pattern, value] of Object.entries(event.patterns)) {
          if (value) {
            const severity = typeof value === "object" ? value.severity : value;
            patternList.push({ name: pattern, severity });
          }
        }
      }
    }
    return patternList;
  }, [events.claudeLocalEvents]);

  // Diagnostic modal state
  const [diagnosticModal, setDiagnosticModal] = useState<{
    open: boolean;
    loading: boolean;
    result: string | null;
    error: string | null;
  }>({ open: false, loading: false, result: null, error: null });

  const runDeepDiagnostic = async () => {
    setDiagnosticModal({ open: true, loading: true, result: null, error: null });

    const diagnosticData = {
      cpu: latest?.cpuLoad ?? 0,
      memory: memPercent,
      memoryUsedGb: ((latest?.memUsedMb ?? 0) / 1024).toFixed(1),
      memoryTotalGb: ((latest?.memTotalMb ?? 0) / 1024).toFixed(0),
      swapGb: ((latest?.swapUsedMb ?? 0) / 1024).toFixed(1),
      networkDown: formatBps(latest?.networkRxPerSec ?? 0),
      networkUp: formatBps(latest?.networkTxPerSec ?? 0),
      claudeApiLatencyMs: claudeApiStats?.latest ?? null,
      claudeApiAvgMs: claudeApiStats?.avg ?? null,
      sessionDuration: latestSession?.durationMinutes ?? 0,
      messageCount: latestSession?.messageCount ?? 0,
      messageToolRatio: latestLocalStats?.messageToolRatio ?? 0,
      topProcesses: watcherLeaderboard.slice(0, 5),
      patterns: allPatterns,
    };

    try {
      const res = await fetch(apiUrl("/api/diagnostic"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diagnosticData }),
      });
      const data = await res.json();

      if (data.success) {
        setDiagnosticModal(prev => ({ ...prev, loading: false, result: data.analysis }));
      } else {
        setDiagnosticModal(prev => ({ ...prev, loading: false, error: data.error }));
      }
    } catch (err) {
      setDiagnosticModal(prev => ({ ...prev, loading: false, error: String(err) }));
    }
  };

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
            <div className="group relative">
              <Badge
                variant={events.mode === "active" ? "default" : "secondary"}
                className="gap-1.5 cursor-help"
              >
                {events.mode === "active" ? (
                  <Zap className="h-3 w-3" />
                ) : (
                  <HardDrive className="h-3 w-3" />
                )}
                {events.mode === "active" ? "Active (OTEL)" : "Passive (Local)"}
              </Badge>
              {events.mode === "passive" && (
                <div className="absolute right-0 top-full mt-2 z-50 hidden group-hover:block w-80 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg">
                  <p className="text-xs font-medium mb-2">Activer le mode OTEL :</p>
                  <div className="space-y-2">
                    <div>
                      <p className="text-[10px] text-muted-foreground mb-1">Claude Code :</p>
                      <code className="block text-[9px] bg-muted p-1.5 rounded font-mono break-all">
                        CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4319 claude
                      </code>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground mb-1">Codex (~/.codex/config.toml) :</p>
                      <code className="block text-[9px] bg-muted p-1.5 rounded font-mono whitespace-pre">
{`[otel]
exporter = "otlp-http"
endpoint = "http://localhost:4319"`}
                      </code>
                    </div>
                  </div>
                </div>
              )}
            </div>
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
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={runDeepDiagnostic}
                  disabled={diagnosticModal.loading}
                  className="gap-2"
                >
                  <Bot className="h-4 w-4" />
                  {diagnosticModal.loading ? "Analyse..." : "Diagnostic Claude"}
                </Button>
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
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {diagnostic.sources.map((source) => (
                <DiagnosticSourceCard key={source.id} source={source} />
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Diagnostic Claude Modal */}
        {diagnosticModal.open && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <Card className="w-full max-w-2xl max-h-[80vh] overflow-auto m-4">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <Bot className="h-5 w-5" />
                    Diagnostic Claude
                  </CardTitle>
                  <Button variant="ghost" size="sm" onClick={() => setDiagnosticModal(prev => ({ ...prev, open: false }))}>
                    <XCircle className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {diagnosticModal.loading && (
                  <div className="flex items-center gap-3 text-muted-foreground">
                    <div className="animate-spin h-5 w-5 border-2 border-primary border-t-transparent rounded-full" />
                    Claude analyse ton système...
                  </div>
                )}
                {diagnosticModal.result && (
                  <div className="prose prose-invert prose-sm max-w-none">
                    <pre className="whitespace-pre-wrap text-sm bg-secondary/50 p-4 rounded-lg">{diagnosticModal.result}</pre>
                  </div>
                )}
                {diagnosticModal.error && (
                  <div className="text-red-400">
                    Erreur: {diagnosticModal.error}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* Metrics History Chart - First for visibility */}
        <MetricsHistoryChart
          systemMetrics={events.systemMetrics}
          latencyEvents={events.latencyEvents}
          claudeEvents={events.claudeEvents}
          claudeLocalEvents={events.claudeLocalEvents}
        />

        {/* Pattern Analysis Panel (shown only when patterns detected) */}
        <PatternAnalysisPanel
          claudeLocalEvents={events.claudeLocalEvents}
          codexLocalEvents={events.codexLocalEvents}
        />

        {/* Tasks Panel (shown when there are pending/blocked tasks) */}
        <TasksPanel claudeLocalEvents={events.claudeLocalEvents} />

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
                              : entry.kind === "local"
                                ? "bg-cyan-500/10 text-cyan-400"
                                : entry.kind === "codex-local"
                                  ? "bg-emerald-500/10 text-emerald-400"
                                  : entry.kind === "codex"
                                    ? "bg-purple-500/10 text-purple-400"
                                    : "bg-purple-500/10 text-purple-400"
                      )}
                    >
                      {entry.kind === "system" ? (
                        <Cpu className="h-4 w-4" />
                      ) : entry.kind === "latency" ? (
                        <Globe className="h-4 w-4" />
                      ) : entry.kind === "claude" ? (
                        <Bot className="h-4 w-4" />
                      ) : entry.kind === "local" ? (
                        <HardDrive className="h-4 w-4" />
                      ) : entry.kind === "codex-local" ? (
                        <Terminal className="h-4 w-4" />
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
                            : selected.kind === "local"
                              ? `Local: ${(selected.data as ClaudeLocalEventRecord).event}`
                              : selected.label}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {selected.kind === "system"
                        ? `${(selected.data.cpuLoad ?? 0).toFixed(1)}% CPU · ${selected.data.watcherCount ?? 0} watchers`
                        : selected.kind === "latency"
                          ? `Anthropic: ${selected.data.anthropicMs ?? "—"}ms · OpenAI: ${selected.data.openaiMs ?? "—"}ms`
                          : selected.kind === "claude"
                            ? `${(selected.data as ClaudeEventRecord).duration_ms ?? "—"}ms${(selected.data as ClaudeEventRecord).model ? ` · ${(selected.data as ClaudeEventRecord).model}` : ""}`
                            : selected.kind === "local"
                              ? `${(selected.data as ClaudeLocalEventRecord).messageCount ?? 0} messages · ${(selected.data as ClaudeLocalEventRecord).durationMinutes ?? 0}min`
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

                  {selected.kind === "local" && (
                    <div className="rounded-lg bg-background/50 p-4">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">
                        Détail Local
                      </p>
                      <div className="mt-2 space-y-2">
                        {(selected.data as ClaudeLocalEventRecord).event === "session_snapshot" && (
                          <>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">Session</span>
                              <span className="font-mono text-xs">{(selected.data as ClaudeLocalEventRecord).sessionId?.slice(0, 8)}...</span>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">Messages</span>
                              <span className="font-mono font-bold">{(selected.data as ClaudeLocalEventRecord).messageCount}</span>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">Durée</span>
                              <span className={cn(
                                "font-mono font-bold",
                                ((selected.data as ClaudeLocalEventRecord).durationMinutes ?? 0) > 240
                                  ? "text-amber-400"
                                  : "text-green-400"
                              )}>
                                {Math.floor(((selected.data as ClaudeLocalEventRecord).durationMinutes ?? 0) / 60)}h{((selected.data as ClaudeLocalEventRecord).durationMinutes ?? 0) % 60}m
                              </span>
                            </div>
                            {(selected.data as ClaudeLocalEventRecord).project && (
                              <div className="flex items-center justify-between text-sm">
                                <span className="text-muted-foreground">Projet</span>
                                <span className="font-mono text-xs truncate max-w-[150px]">{(selected.data as ClaudeLocalEventRecord).project?.split("/").slice(-2).join("/")}</span>
                              </div>
                            )}
                          </>
                        )}
                        {(selected.data as ClaudeLocalEventRecord).event === "daily_stats" && (
                          <>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">Date</span>
                              <span className="font-mono">{(selected.data as ClaudeLocalEventRecord).date}</span>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">Messages</span>
                              <span className="font-mono font-bold">{(selected.data as ClaudeLocalEventRecord).messageCount}</span>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">Tool Calls</span>
                              <span className="font-mono">{(selected.data as ClaudeLocalEventRecord).toolCallCount}</span>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">Ratio Msg/Tool</span>
                              <span className={cn(
                                "font-mono font-bold",
                                ((selected.data as ClaudeLocalEventRecord).messageToolRatio ?? 0) > 10
                                  ? "text-red-400"
                                  : ((selected.data as ClaudeLocalEventRecord).messageToolRatio ?? 0) > 7
                                    ? "text-amber-400"
                                    : "text-green-400"
                              )}>
                                {(selected.data as ClaudeLocalEventRecord).messageToolRatio?.toFixed(1)}
                              </span>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">Sessions</span>
                              <span className="font-mono">{(selected.data as ClaudeLocalEventRecord).sessionCount}</span>
                            </div>
                          </>
                        )}
                        {(selected.data as ClaudeLocalEventRecord).patterns && Object.keys((selected.data as ClaudeLocalEventRecord).patterns!).length > 0 && (
                          <div className="mt-3 pt-3 border-t border-border">
                            <p className="text-xs uppercase tracking-wide text-amber-400 mb-2">Patterns détectés</p>
                            {Object.entries((selected.data as ClaudeLocalEventRecord).patterns!).map(([key, value]) => {
                              const severity = typeof value === "object" ? value.severity : value;
                              return (
                                <div key={key} className="flex items-center justify-between text-sm">
                                  <span className="text-muted-foreground">{key}</span>
                                  <Badge variant={severity === "error" ? "destructive" : "warning"}>
                                    {severity}
                                  </Badge>
                                </div>
                              );
                            })}
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
 * Diagnostic source card with tooltip explanations
 * Click to lock tooltip open for text selection/copy
 */
function DiagnosticSourceCard({ source }: { source: SourceStatus }) {
  const [showTooltip, setShowTooltip] = useState(false);
  const [locked, setLocked] = useState(false);
  const explanation = METRIC_EXPLANATIONS[source.id];

  const statusContent = source.status === "error"
    ? explanation?.error
    : source.status === "warning"
      ? explanation?.warning
      : null;

  const handleClick = () => {
    setLocked(!locked);
    setShowTooltip(!locked);
  };

  const handleMouseEnter = () => {
    if (!locked) setShowTooltip(true);
  };

  const handleMouseLeave = () => {
    if (!locked) setShowTooltip(false);
  };

  return (
    <div
      className="relative group"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        onClick={handleClick}
        className={cn(
          "flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-all",
          source.status === "error"
            ? "border-red-500/30 bg-red-500/10"
            : source.status === "warning"
              ? "border-amber-500/30 bg-amber-500/10"
              : source.status === "ok"
                ? "border-green-500/30 bg-green-500/10"
                : "border-border bg-secondary/30",
          locked && "ring-2 ring-primary/50"
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

      {/* Tooltip - Click to lock, click again or X to close */}
      {showTooltip && (explanation || source.details) && (
        <div
          className={cn(
            "absolute left-0 top-full mt-2 z-50 w-80 rounded-lg border bg-popover p-4 shadow-lg text-popover-foreground select-text",
            locked && "ring-2 ring-primary"
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-2 mb-2">
            <p className="font-medium flex items-center gap-2">
              <Info className="h-4 w-4 text-primary" />
              {explanation?.what || source.name}
            </p>
            {locked && (
              <button
                onClick={() => { setLocked(false); setShowTooltip(false); }}
                className="text-muted-foreground hover:text-foreground p-0.5"
              >
                <XCircle className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Show details array if present (for merged cards like Claude Local) */}
          {source.details && source.details.length > 0 && (
            <div className="border-t border-border pt-3 mt-2 space-y-2">
              {source.details.map((detail, i) => (
                <div key={i} className="flex items-start justify-between gap-2">
                  <span className="text-xs text-muted-foreground">{detail.label}</span>
                  <span className={cn(
                    "text-xs font-medium text-right",
                    detail.status === "error" ? "text-red-400" :
                    detail.status === "warning" ? "text-amber-400" :
                    "text-green-400"
                  )}>
                    {detail.status === "error" ? "🔴 " : detail.status === "warning" ? "🟡 " : "🟢 "}
                    {detail.value}
                  </span>
                </div>
              ))}
            </div>
          )}

          {statusContent && (
            <div className="border-t border-border pt-3 mt-3 space-y-2">
              <p className={cn(
                "text-sm font-medium",
                source.status === "error" ? "text-red-400" : "text-amber-400"
              )}>
                {source.status === "error" ? "🔴" : "🟡"} {statusContent.problem}
              </p>
              <p className="text-sm text-muted-foreground">
                {statusContent.implications}
              </p>
              <div className="text-xs text-muted-foreground">
                <span className="font-medium">Causes possibles :</span>
                <ul className="list-disc list-inside mt-1 space-y-0.5">
                  {statusContent.causes.map((cause, i) => (
                    <li key={i}>{cause}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {!statusContent && !source.details && (
            <p className="text-xs text-green-400 mt-2">
              Tout va bien de ce côté.
            </p>
          )}

          {locked && (
            <p className="text-[10px] text-muted-foreground mt-3 border-t border-border pt-2">
              Cliquez sur la carte ou × pour fermer. Texte sélectionnable.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// Pattern suggestions mapping
const PATTERN_SUGGESTIONS: Record<string, { title: string; suggestion: string }> = {
  highMessageToolRatio: {
    title: "Ratio Message/Tool élevé",
    suggestion: "Beaucoup de messages par rapport aux appels d'outils. L'agent pourrait être bloqué ou en attente de clarification.",
  },
  longRunningSession: {
    title: "Session longue",
    suggestion: "Cette session dure depuis plusieurs heures. Envisagez de la redémarrer pour éviter l'accumulation de contexte.",
  },
  blockedTasks: {
    title: "Tâches bloquées",
    suggestion: "Des tâches attendent des dépendances. Vérifiez les blocages et résolvez-les pour continuer.",
  },
  manyBlockedTasks: {
    title: "Nombreuses tâches bloquées",
    suggestion: "Plusieurs tâches sont en attente. Priorisez et résolvez les blocages critiques.",
  },
  // Codex patterns
  highPromptFrequency: {
    title: "Fréquence de prompts élevée",
    suggestion: "Beaucoup de prompts envoyés récemment. Vérifiez si l'agent n'est pas bloqué dans une boucle.",
  },
};

/**
 * Metrics History Chart - Visualizes system metrics over time
 */
function MetricsHistoryChart({
  systemMetrics,
  latencyEvents,
  claudeEvents,
  claudeLocalEvents,
}: {
  systemMetrics: SystemMetricsRecord[];
  latencyEvents: LatencyEventRecord[];
  claudeEvents: ClaudeEventRecord[];
  claudeLocalEvents: ClaudeLocalEventRecord[];
}) {
  const [selectedMetrics, setSelectedMetrics] = useState<string[]>(["cpu", "ram"]);

  // Prepare chart data from all metrics
  const chartData = useMemo(() => {
    const dataMap = new Map<number, Record<string, number | string>>();

    // Add system metrics
    for (const m of systemMetrics) {
      const timeKey = Math.floor(m.ts / 1000) * 1000; // Round to seconds
      const existing = dataMap.get(timeKey) || { time: timeKey };
      existing.cpu = m.cpuLoad ?? 0;
      existing.ram = m.memTotalMb && m.memUsedMb
        ? Math.round((m.memUsedMb / m.memTotalMb) * 100)
        : 0;
      existing.swap = m.swapUsedMb ? Math.round(m.swapUsedMb / 1024 * 10) / 10 : 0; // GB
      existing.networkRx = m.networkRxPerSec ? Math.round(m.networkRxPerSec / 1024) : 0; // KB/s
      existing.networkTx = m.networkTxPerSec ? Math.round(m.networkTxPerSec / 1024) : 0; // KB/s
      dataMap.set(timeKey, existing);
    }

    // Add latency ping data
    for (const l of latencyEvents) {
      const timeKey = Math.floor(l.ts / 1000) * 1000;
      const existing = dataMap.get(timeKey) || { time: timeKey };
      existing.anthropicPing = l.anthropicMs ?? 0;
      dataMap.set(timeKey, existing);
    }

    // Add Claude OTEL API latency (real API calls)
    for (const c of claudeEvents) {
      if (c.event === "api_request" && c.duration_ms) {
        const timeKey = Math.floor(c.ts / 1000) * 1000;
        const existing = dataMap.get(timeKey) || { time: timeKey };
        // Keep the max latency if multiple calls in same second
        existing.claudeApi = Math.max((existing.claudeApi as number) || 0, c.duration_ms);
        dataMap.set(timeKey, existing);
      }
    }

    // Add Claude local stats (message/tool ratio)
    for (const l of claudeLocalEvents) {
      if (l.event === "daily_stats" && l.messageToolRatio) {
        const timeKey = Math.floor(l.ts / 1000) * 1000;
        const existing = dataMap.get(timeKey) || { time: timeKey };
        existing.ratio = l.messageToolRatio;
        dataMap.set(timeKey, existing);
      }
    }

    // Sort by time and return
    return Array.from(dataMap.values())
      .sort((a, b) => (a.time as number) - (b.time as number))
      .slice(-60); // Keep last 60 data points
  }, [systemMetrics, latencyEvents, claudeEvents, claudeLocalEvents]);

  const metricConfigs = [
    { key: "cpu", label: "CPU", color: "#3b82f6", unit: "%", domain: [0, 100] },
    { key: "ram", label: "RAM", color: "#8b5cf6", unit: "%", domain: [0, 100] },
    { key: "swap", label: "Swap", color: "#f59e0b", unit: "GB", domain: [0, 8] },
    { key: "networkRx", label: "Net ↓", color: "#10b981", unit: "KB/s", domain: [0, "auto"] },
    { key: "networkTx", label: "Net ↑", color: "#06b6d4", unit: "KB/s", domain: [0, "auto"] },
    { key: "anthropicPing", label: "Ping API", color: "#f97316", unit: "ms", domain: [0, "auto"] },
    { key: "claudeApi", label: "Claude API", color: "#ec4899", unit: "ms", domain: [0, "auto"] },
    { key: "ratio", label: "Msg/Tool", color: "#a855f7", unit: "", domain: [0, 15] },
  ];

  const toggleMetric = (key: string) => {
    setSelectedMetrics(prev =>
      prev.includes(key)
        ? prev.filter(k => k !== key)
        : [...prev, key]
    );
  };

  const formatTime = (ts: number) => {
    const date = new Date(ts);
    return date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  };

  const formatTooltipValue = (value: number, name: string) => {
    const config = metricConfigs.find(c => c.label === name);
    return `${value}${config?.unit || ""}`;
  };

  if (chartData.length < 2) {
    return null; // Not enough data to show a chart
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base font-medium flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            Historique des métriques
          </CardTitle>
          <div className="flex flex-wrap gap-1.5">
            {metricConfigs.map(config => (
              <button
                key={config.key}
                onClick={() => toggleMetric(config.key)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-all",
                  selectedMetrics.includes(config.key)
                    ? "bg-secondary text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <div
                  className="h-2 w-2 rounded-full"
                  style={{
                    backgroundColor: selectedMetrics.includes(config.key)
                      ? config.color
                      : "currentColor",
                    opacity: selectedMetrics.includes(config.key) ? 1 : 0.3,
                  }}
                />
                {config.label}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ChartContainer className="h-[200px]">
          <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <defs>
              {metricConfigs.map(config => (
                <linearGradient key={config.key} id={`gradient-${config.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={config.color} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={config.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted/30" />
            <XAxis
              dataKey="time"
              tickFormatter={formatTime}
              tick={{ fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              className="text-muted-foreground"
            />
            <YAxis
              tick={{ fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              className="text-muted-foreground"
              domain={[0, 100]}
            />
            <Tooltip
              content={({ active, payload, label }) => (
                <ChartTooltip
                  active={active}
                  payload={payload?.map(p => ({
                    name: p.name as string,
                    value: p.value as number,
                    color: p.color as string,
                    dataKey: p.dataKey as string,
                  }))}
                  label={formatTime(label as number)}
                  formatter={formatTooltipValue}
                />
              )}
            />
            {metricConfigs.map(config =>
              selectedMetrics.includes(config.key) ? (
                <Area
                  key={config.key}
                  type="monotone"
                  dataKey={config.key}
                  name={config.label}
                  stroke={config.color}
                  strokeWidth={2}
                  fill={`url(#gradient-${config.key})`}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2 }}
                />
              ) : null
            )}
          </AreaChart>
        </ChartContainer>
        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>{chartData.length} points · Intervalle ~10s</span>
          <span>Dernière mise à jour: {formatTime(chartData[chartData.length - 1]?.time as number)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function PatternAnalysisPanel({
  claudeLocalEvents,
  codexLocalEvents,
}: {
  claudeLocalEvents: ClaudeLocalEventRecord[];
  codexLocalEvents: CodexLocalEventRecord[];
}) {
  // Collect all patterns from recent events (both Claude and Codex)
  const allPatterns = useMemo(() => {
    const patternMap = new Map<string, {
      severity: string;
      count: number;
      agent: string;
      details?: { sessionId?: string; project?: string; durationMinutes?: number };
    }>();

    // Claude patterns
    for (const event of claudeLocalEvents.slice(-20)) {
      if (event.patterns) {
        for (const [pattern, value] of Object.entries(event.patterns)) {
          if (value) {
            // Handle both old format (string) and new format (object)
            const severity = typeof value === "object" ? value.severity : value;
            const details = typeof value === "object" ? value : undefined;

            const existing = patternMap.get(pattern);
            if (existing) {
              existing.count++;
              if (severity === "error" && existing.severity === "warning") {
                existing.severity = "error";
              }
              // Keep most recent details
              if (details) existing.details = details;
            } else {
              patternMap.set(pattern, { severity, count: 1, agent: "Claude", details });
            }
          }
        }
      }
    }

    // Codex patterns
    for (const event of codexLocalEvents.slice(-20)) {
      if (event.patterns) {
        for (const [pattern, value] of Object.entries(event.patterns)) {
          if (value) {
            const severity = typeof value === "object" ? value.severity : value;
            const details = typeof value === "object" ? value : undefined;
            const key = `codex_${pattern}`;
            const existing = patternMap.get(key);
            if (existing) {
              existing.count++;
              if (severity === "error" && existing.severity === "warning") {
                existing.severity = "error";
              }
              if (details) existing.details = details;
            } else {
              patternMap.set(key, { severity, count: 1, agent: "Codex", details });
            }
          }
        }
      }
    }

    return Array.from(patternMap.entries()).map(([pattern, data]) => ({
      pattern: pattern.replace("codex_", ""),
      severity: data.severity,
      count: data.count,
      agent: data.agent,
      details: data.details,
      ...PATTERN_SUGGESTIONS[pattern.replace("codex_", "")],
    }));
  }, [claudeLocalEvents, codexLocalEvents]);

  if (allPatterns.length === 0) {
    return null;
  }

  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-amber-400" />
          <CardTitle className="text-base font-medium">
            Patterns Détectés
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {allPatterns.map(({ pattern, severity, count, title, suggestion, agent, details }) => (
          <div
            key={pattern}
            className={cn(
              "rounded-lg border p-3",
              severity === "error"
                ? "border-red-500/30 bg-red-500/10"
                : "border-amber-500/30 bg-amber-500/10"
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <p className={cn(
                    "font-medium",
                    severity === "error" ? "text-red-400" : "text-amber-400"
                  )}>
                    {title || pattern}
                  </p>
                  <Badge variant="outline" className="text-[10px] px-1 py-0">
                    {agent}
                  </Badge>
                  {details?.project && (
                    <Badge variant="outline" className="text-[10px] px-1 py-0 font-mono">
                      {details.project}
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {details?.durationMinutes
                    ? `Session ${details.sessionId || "?"} active depuis ${Math.floor(details.durationMinutes / 60)}h${details.durationMinutes % 60}min. ${suggestion || ""}`
                    : suggestion || "Pattern détecté dans les données locales."}
                </p>
              </div>
              <Badge variant={severity === "error" ? "destructive" : "warning"}>
                {details?.durationMinutes
                  ? `${Math.floor(details.durationMinutes / 60)}h${details.durationMinutes % 60}m`
                  : severity}
              </Badge>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * Tasks Panel - Shows pending and blocked tasks with actions
 */
function TasksPanel({
  claudeLocalEvents,
}: {
  claudeLocalEvents: ClaudeLocalEventRecord[];
}) {
  const [isClearing, setIsClearing] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showAll, setShowAll] = useState(false);

  // Get latest task status event
  const latestTaskEvent = useMemo(() => {
    return claudeLocalEvents
      .filter((e) => e.event === "task_status")
      .at(-1);
  }, [claudeLocalEvents]);

  if (!latestTaskEvent || (!latestTaskEvent.pendingCount && !latestTaskEvent.blockedCount)) {
    return null;
  }

  const tasks: Array<{ id: string; subject?: string; status: string }> = latestTaskEvent.tasks || [];
  const blockedCount = latestTaskEvent.blockedCount || 0;
  const pendingCount = latestTaskEvent.pendingCount || 0;
  const displayedTasks = showAll ? tasks : tasks.slice(0, 5);
  const hiddenCount = pendingCount - displayedTasks.length;

  const handleOpenTerminal = async () => {
    try {
      await fetch(`${API_ORIGIN}/api/tasks/open-terminal`, { method: "POST" });
    } catch (err) {
      console.error("Failed to open terminal:", err);
    }
  };

  const handleClearTasks = async () => {
    const confirmed = confirm(
      "⚠️ Attention : Ceci va supprimer les tâches anciennes (>7 jours) de ~/.claude/tasks/.\n\n" +
      "Les tâches récentes (sessions en cours) seront préservées.\n\n" +
      "Continuer ?"
    );
    if (!confirmed) return;
    setIsClearing(true);
    try {
      await fetch(`${API_ORIGIN}/api/tasks/clear`, { method: "POST" });
    } catch (err) {
      console.error("Failed to clear tasks:", err);
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-medium flex items-center gap-2">
            <Terminal className="h-4 w-4" />
            Tâches Claude Code
            <Button
              variant="ghost"
              size="sm"
              className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
              onClick={() => setShowHelp(!showHelp)}
            >
              <Info className="h-3.5 w-3.5" />
            </Button>
          </CardTitle>
          <div className="flex gap-2">
            {pendingCount > 0 && (
              <Badge variant="outline">{pendingCount} en attente</Badge>
            )}
            {blockedCount > 0 && (
              <Badge variant="warning">{blockedCount} bloquées</Badge>
            )}
          </div>
        </div>
        {showHelp && (
          <div className="mt-2 rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
            <p className="mb-2">
              Ces tâches viennent de <code className="text-xs bg-background px-1 rounded">~/.claude/tasks/</code>.
              Ce sont des todo lists créées par Claude Code dans des sessions précédentes.
            </p>
            <p>
              <strong>Bloquées</strong> = attendent qu'une autre tâche soit finie.
              <br />
              <strong>Pending</strong> = en attente d'être traitées.
            </p>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aucune tâche visible
          </p>
        ) : (
          <div className="space-y-2">
            {displayedTasks.map((task) => (
              <div
                key={task.id}
                className={cn(
                  "flex items-center justify-between rounded-lg border px-3 py-2",
                  task.status === "in_progress"
                    ? "border-blue-500/30 bg-blue-500/10"
                    : "border-border bg-secondary/30"
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {task.subject || task.id}
                  </p>
                </div>
                <Badge
                  variant={task.status === "in_progress" ? "default" : "secondary"}
                  className="ml-2 shrink-0 text-[10px]"
                >
                  {task.status === "in_progress" ? "en cours" : task.status}
                </Badge>
              </div>
            ))}
            {hiddenCount > 0 && !showAll && (
              <button
                onClick={() => setShowAll(true)}
                className="w-full text-xs text-primary hover:text-primary/80 text-center py-1 hover:bg-secondary/50 rounded transition-colors"
              >
                + {hiddenCount} autres tâches (cliquer pour voir)
              </button>
            )}
            {showAll && tasks.length > 5 && (
              <button
                onClick={() => setShowAll(false)}
                className="w-full text-xs text-muted-foreground hover:text-foreground text-center py-1 hover:bg-secondary/50 rounded transition-colors"
              >
                Réduire
              </button>
            )}
          </div>
        )}

        <div className="flex gap-2 pt-2 border-t border-border">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 gap-2"
            onClick={handleOpenTerminal}
          >
            <Terminal className="h-3.5 w-3.5" />
            Ouvrir Claude Code
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-2 text-muted-foreground hover:text-destructive"
            onClick={handleClearTasks}
            disabled={isClearing}
          >
            <XCircle className="h-3.5 w-3.5" />
            {isClearing ? "..." : "Nettoyer"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
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
