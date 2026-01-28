# Dual-Mode Monitoring

Le dashboard supporte deux modes de monitoring pour Claude Code et Codex :
- **Mode Actif (OTEL)** : Télémétrie temps réel via OpenTelemetry
- **Mode Passif (Local)** : Analyse des fichiers locaux

Le mode est détecté automatiquement et affiché dans le header.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         DASHBOARD                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │  Diagnostic  │  │   Timeline   │  │  Pattern Analysis    │   │
│  │    Panel     │  │   unifiée    │  │       Panel          │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ /api/events
              ┌───────────────┴───────────────┐
              │         server.mjs            │
              │  (agrège toutes les sources)  │
              └───────────────┬───────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ otel-collector  │  │ claude-local    │  │ codex-local     │
│   (port 4319)   │  │   collector     │  │   collector     │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ Claude/Codex    │  │  ~/.claude/     │  │  ~/.codex/      │
│ avec OTEL       │  │  (fichiers)     │  │  (fichiers)     │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

---

## Collecteurs

### 1. OTEL Collector (`scripts/otel-collector.mjs`)

Serveur HTTP qui reçoit les événements OpenTelemetry.

**Port :** `4319` (configurable via `OTEL_COLLECTOR_PORT`)

**Endpoints :**
- `POST /v1/logs` - Événements OTLP (logs)
- `POST /v1/metrics` - Métriques OTLP
- `GET /health` - Health check

**Événements parsés :**

| Préfixe | Agent | Exemples |
|---------|-------|----------|
| `claude_code.*` | Claude | `api_request`, `tool_result`, `api_error` |
| `codex.*` | Codex | `conversation_starts`, `api_request`, `tool_decision` |

**Output :** `temp/ai-dashboard/claude-otel-events.jsonl`

```json
{
  "ts": 1769596740788,
  "agent": "claude",
  "event": "api_request",
  "duration_ms": 3421,
  "model": "claude-opus-4-5-20251101",
  "input_tokens": 15000,
  "output_tokens": 2000
}
```

---

### 2. Claude Local Collector (`scripts/claude-local-collector.mjs`)

Lit les fichiers locaux de Claude Code.

**Intervalle :** 30 secondes

**Sources :**

| Fichier | Contenu |
|---------|---------|
| `~/.claude/history.jsonl` | Historique des prompts utilisateur |
| `~/.claude/stats-cache.json` | Stats quotidiennes agrégées |
| `~/.claude/tasks/*/` | Fichiers de tâches |

**Output :** `temp/ai-dashboard/claude-local-events.jsonl`

**Types d'événements :**

```json
// Session snapshot
{
  "ts": 1769596740788,
  "source": "local",
  "event": "session_snapshot",
  "sessionId": "xxx",
  "messageCount": 15,
  "durationMinutes": 138,
  "project": "/path/to/project",
  "patterns": { "longRunningSession": "warning" }
}

// Daily stats
{
  "ts": 1769596740788,
  "source": "local",
  "event": "daily_stats",
  "date": "2026-01-28",
  "messageCount": 11771,
  "toolCallCount": 1725,
  "messageToolRatio": 6.8,
  "sessionCount": 83
}

// Task status
{
  "ts": 1769596740788,
  "source": "local",
  "event": "task_status",
  "pendingCount": 9,
  "blockedCount": 3,
  "tasks": [...]
}
```

---

### 3. Codex Local Collector (`scripts/codex-local-collector.mjs`)

Lit les fichiers locaux de Codex.

**Intervalle :** 30 secondes

**Sources :**

| Fichier | Contenu |
|---------|---------|
| `~/.codex/history.jsonl` | Historique des prompts |
| `~/.codex/sessions/YYYY/MM/DD/*.jsonl` | Transcripts de session |

**Output :** `temp/ai-dashboard/codex-local-events.jsonl`

**Types d'événements :**

```json
// Session snapshot (from history)
{
  "ts": 1769596740788,
  "source": "local",
  "agent": "codex",
  "event": "session_snapshot",
  "sessionId": "xxx",
  "promptCount": 12,
  "durationMinutes": 45
}

// Session file (from transcript)
{
  "ts": 1769596740788,
  "source": "local",
  "agent": "codex",
  "event": "session_file",
  "sessionId": "xxx",
  "cliVersion": "0.91.0",
  "model": "openai",
  "messageCount": 25,
  "toolCount": 8
}

// Daily stats
{
  "ts": 1769596740788,
  "source": "local",
  "agent": "codex",
  "event": "daily_stats",
  "date": "2026-01-28",
  "sessionCount": 5,
  "promptCount": 47
}
```

---

## Détection de Patterns

Les collecteurs locaux analysent les données et détectent des patterns problématiques.

### Seuils de détection

| Pattern | Seuil Warning | Seuil Error | Agent |
|---------|---------------|-------------|-------|
| `highMessageToolRatio` | > 7.0 | > 10.0 | Claude |
| `longRunningSession` | > 4h | > 8h | Claude |
| `blockedTasks` | > 2 | > 5 | Claude |
| `highPromptFrequency` | > 50/h | > 100/h | Codex |
| `longRunningSession` | > 2h | > 4h | Codex |

### Suggestions

| Pattern | Signification | Action suggérée |
|---------|---------------|-----------------|
| `highMessageToolRatio` | Agent parle mais n'agit pas | Vérifier si bloqué, reformuler |
| `longRunningSession` | Contexte accumulé | Relancer la session |
| `blockedTasks` | Dépendances non résolues | Débloquer les tâches |
| `highPromptFrequency` | Beaucoup de prompts | Vérifier boucle infinie |

---

## Diagnostic Panel - Scoring

Chaque source de données a un **score** (0-100) indiquant sa probabilité d'être la cause d'un problème.

### Sources et scores

```javascript
// CPU
score: cpuLoad > 80 ? 90 : cpuLoad > 60 ? 50 : 0

// Mémoire
score: memPercent > 90 ? 85 : memPercent > 75 ? 40 : 0

// Claude API (OTEL)
score: latency > 10000 ? 95 : latency > 5000 ? 70 : 0

// Message/Tool Ratio (Local)
score: ratio > 10 ? 85 : ratio > 7 ? 55 : 0

// Session durée (Local)
score: duration > 480min ? 70 : duration > 240min ? 40 : 0

// Tâches bloquées (Local)
score: blocked > 5 ? 70 : blocked > 2 ? 35 : 0
```

### Résumé automatique

- **Score >= 80** : "Cause probable : {source} ({valeur})"
- **Score >= 40** : "Attention : {source} montre des signes de stress"
- **Score < 40** : "Tout semble normal"

---

## Configuration OTEL

### Claude Code

```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1 \
OTEL_LOGS_EXPORTER=otlp \
OTEL_METRICS_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4319 \
claude
```

### Codex

Ajouter dans `~/.codex/config.toml` :

```toml
[otel]
environment = "dev"
exporter = "otlp-http"
endpoint = "http://localhost:4319"
log_user_prompt = false
```

---

## API Server

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/events` | Toutes les données (system, process, latency, claude, codex, local) |
| `GET /api/mode` | Mode actuel (`active` ou `passive`) |
| `GET /api/state` | État du monitoring (enabled/disabled) |
| `POST /api/state` | Toggle monitoring |

### Réponse `/api/events`

```json
{
  "systemMetrics": [...],
  "processStats": [...],
  "codexEvents": [...],
  "codexLocalEvents": [...],
  "latencyEvents": [...],
  "claudeEvents": [...],
  "claudeLocalEvents": [...],
  "mode": "passive"
}
```

### Détection du mode

```javascript
async function checkOtelStatus() {
  // 1. Health check sur port 4319
  const res = await fetch("http://localhost:4319/health");
  if (!res.ok) return false;

  // 2. Vérifier événements récents (< 5 min)
  const events = await readJsonLines(FILE_NAMES.claude, 10);
  const latestTs = events.at(-1)?.ts;
  return latestTs > Date.now() - 5 * 60 * 1000;
}
```

---

## Scripts npm

| Script | Description |
|--------|-------------|
| `npm run dev:all` | Lance tout (vite, server, collectors) |
| `npm run otel-collector` | Collecteur OTEL seul |
| `npm run claude-local` | Collecteur Claude local seul |
| `npm run codex-local` | Collecteur Codex local seul |

---

## Fichiers de données

| Fichier | Source | Contenu |
|---------|--------|---------|
| `claude-otel-events.jsonl` | OTEL | Événements temps réel Claude/Codex |
| `claude-local-events.jsonl` | Local | Sessions, stats, tâches Claude |
| `codex-local-events.jsonl` | Local | Sessions, stats Codex |

Tous dans `temp/ai-dashboard/`, rotation automatique à 500 lignes.

---

## Comparaison des modes

| Donnée | OTEL | Local |
|--------|------|-------|
| Latence API exacte | ✅ | ❌ |
| Tokens/Coût | ✅ | ❌ |
| Erreurs API | ✅ | ❌ |
| Historique sessions | ⚠️ | ✅ |
| Patterns détectés | ❌ | ✅ |
| Configuration | Variables env | Aucune |
