# AI Pulse Dashboard

Dashboard local de monitoring en temps réel pour diagnostiquer les ralentissements des agents IA (Claude Code, Codex, Cursor).

**Objectif** : Comprendre rapidement si un ralentissement vient de ta machine (CPU, RAM, swap), d'un process gourmand, ou de l'API elle-même.

## Composants

### 1. Dashboard Web (`localhost:5173`)

Interface React qui affiche en temps réel :
- **Cartes métriques** : CPU, RAM, Disk I/O, Réseau, Claude Code API
- **Timeline unifiée** : Tous les événements (système, Claude, Codex) sur une ligne temporelle
- **Leaderboard** : Top processus surveillés (node, vite, docker, cursor...)
- **Diagnostic automatique** : Panel qui identifie la cause probable d'un ralentissement

### 2. Backend API (`localhost:3333`)

Serveur Express qui :
- Agrège les données de tous les collectors
- Expose `/api/events` (métriques) et `/api/state` (toggle on/off)
- Lance automatiquement les scripts collectors en background
- Gère la rotation des fichiers JSONL

### 3. Collectors

| Script | Port | Rôle |
|--------|------|------|
| `collector.mjs` | — | CPU, RAM, Disk I/O, Network, processus |
| `otel-collector.mjs` | 4318 | Reçoit les métriques OTEL de Claude Code |
| `codex-log-monitor.mjs` | — | Parse `~/.ai-perf.log` pour Codex |
| `latency-monitor.mjs` | — | Ping réseau (backup, non affiché) |

## Stack

- **Frontend** : React 19 + TypeScript + Vite + Tailwind CSS + shadcn/ui
- **Backend** : Express.js + Node.js
- **Data** : systeminformation + OpenTelemetry OTLP

## Quick Start

```bash
# Installation
npm install

# Tout lancer d'un coup
npm run dev:all

# Ou individuellement
npm run dev            # Vite (UI) → http://localhost:5173
npm run server         # API Express → http://localhost:3333
npm run collector      # Métriques système
npm run codex-log      # Surveillance ~/.ai-perf.log
npm run otel-collector # OTLP collector → http://localhost:4318
```

## Configuration Claude Code (IMPORTANT)

Pour capturer les **vraies latences API** de Claude Code, lance-le avec ces variables :

```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1 \
OTEL_LOGS_EXPORTER=otlp \
OTEL_METRICS_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
claude
```

Tu peux créer un alias dans ton `~/.zshrc` :

```bash
alias claude-mon='CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_LOGS_EXPORTER=otlp OTEL_METRICS_EXPORTER=otlp OTEL_EXPORTER_OTLP_PROTOCOL=http/json OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 claude'
```

## Configuration Codex CLI

Pour logger les temps d'exécution Codex, source le wrapper :

```bash
source /path/to/ai-dashboard/scripts/codexp.sh
```

Puis utilise `codexp` au lieu de `codex` :

```bash
codexp "ton prompt ici"
```

## Production

```bash
npm run build
npm start         # Sert l'UI buildée + API sur http://localhost:3333
```

## Architecture

```
┌────────────────┐
│  Claude Code   │──────┐
│  (avec OTEL)   │      │ OTLP http/json
└────────────────┘      │
                        ▼
┌────────────────┐   ┌──────────────────────┐
│  Codex CLI     │──▶│  otel-collector.mjs  │──┐
│  (via codexp)  │   │  localhost:4318      │  │
└────────────────┘   └──────────────────────┘  │
                                               │
┌────────────────────────────────────────────────────┐
│              Frontend (localhost:5173)             │
│           React + shadcn/ui + Tailwind             │
└─────────────────────┬──────────────────────────────┘
                      │ polling /api/*
┌─────────────────────▼──────────────────────────────┐
│             Backend (localhost:3333)               │
│  GET /api/events → system + process + claude + ... │
│  GET/POST /api/state → toggle watchers             │
└─────────────────────┬──────────────────────────────┘
                      │
   ┌──────────────────┼──────────────────┐
   ▼                  ▼                  ▼
collector.mjs    latency-monitor    JSONL files
(CPU/RAM/IO)     (ping APIs)        (temp/ai-dashboard/)
```

## Données

Les fichiers sont stockés dans `temp/ai-dashboard/` :

| Fichier                   | Description                                    |
| ------------------------- | ---------------------------------------------- |
| `system-metrics.jsonl`    | CPU, RAM, disk I/O, réseau                     |
| `process-stats.jsonl`     | Top processes + watchers                       |
| `codex-events.jsonl`      | Événements Codex (via codexp wrapper)          |
| `latency-events.jsonl`    | Ping réseau (Anthropic, OpenAI)                |
| `claude-otel-events.jsonl`| **Vraies métriques Claude Code via OTEL**      |
| `watching-state.json`     | État du toggle (enabled/disabled)              |

Les fichiers JSONL sont automatiquement rotés (max 500 lignes).

## Environnement

| Variable                           | Default | Description                    |
| ---------------------------------- | ------- | ------------------------------ |
| `PORT`                             | 3333    | Port du serveur Express        |
| `OTEL_COLLECTOR_PORT`              | 4318    | Port du collecteur OTLP        |
| `VITE_API_ORIGIN`                  | ``      | URL de l'API (pour dev séparé) |
| `AI_DASHBOARD_INTERVAL_MS`         | 2000    | Intervalle de sampling système |
| `AI_DASHBOARD_LATENCY_INTERVAL_MS` | 10000   | Intervalle de ping latence API |

## Watchers surveillés

Le collector filtre les processus contenant : `node`, `vite`, `docker`, `codex`, `claude`, `cursor`

## Fonctionnalités

- **Timeline unifiée** : système + Claude Code + Codex + latence
- **Vraies métriques Claude Code** via OpenTelemetry :
  - `api_request` avec `duration_ms` (le VRAI temps de réponse)
  - `tool_result` avec durée d'exécution
  - Tokens input/output, coût, modèle utilisé
- **Diagnostic automatique** : identifie la cause probable des ralentissements
- Métriques système en temps réel (CPU, RAM, Disk, Network)
- Leaderboard des processus surveillés
- Toggle global pour pause/resume des collectors
- UI dark mode avec shadcn/ui

## Métriques disponibles

| Source | Type | Données |
|--------|------|---------|
| **Claude Code (OTEL)** | Réel | `duration_ms`, model, tokens, cost |
| **Codex (wrapper)** | Réel | `total_ms` par commande |
| **Système** | Réel | CPU, RAM, Swap, Disk I/O, Network |
| **Processus** | Réel | node, vite, docker, cursor |

## Diagnostic automatique

Le panel de diagnostic analyse en temps réel :

| Source | Seuils |
|--------|--------|
| CPU | > 60% warning, > 80% error |
| RAM | > 70% warning, > 85% error |
| Swap | > 1GB warning, > 4GB error |
| Claude Code API | > 5s warning, > 10s error |
| Process gourmand | > 30% CPU warning, > 50% error |

Le diagnostic affiche un résumé avec la **cause probable** du ralentissement.

## Indicateurs visuels

- **Vert** : OK
- **Orange** : Attention
- **Rouge** : Problème identifié
