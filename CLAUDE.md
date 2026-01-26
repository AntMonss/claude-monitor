# Claude Monitor - System & Agent Monitoring

Application macOS menubar pour monitorer les agents IA, serveurs et ressources système.

## Icône

Indicateur de status dans la menubar (rond de couleur) :
- 🟢 Tout va bien
- 🟡 Attention modérée (mémoire >75%, >3 agents)
- 🟠 Attention (mémoire >85%, >6 agents)
- 🔴 Problème (orphelins détectés)

## Fonctionnalités

- **Agents** : Claude interactifs, subagents, workers, Codex
- **Serveurs** : Ports 3000, 3001, 3002, 3120 avec bouton Stop
- **Ralph** : Progression, temps écoulé, cron, bouton Stop
- **Orphelins** : Liste avec Kill individuel + Cleanup all
- **Système** : RAM%, CPU%
- **Dashboard** : Lancement automatique en background + ouverture navigateur

## Structure

```
Sources/ClaudeMonitor/
├── ClaudeMonitorApp.swift   # Point d'entrée, menubar
├── MonitorView.swift        # UI monitoring (sections)
└── ProcessMonitor.swift     # Détection processus + actions
```

## Commandes

```bash
# Build et run
./run.sh

# Ou manuellement
swift build && .build/debug/ClaudeMonitor
```

## Points d'entrée

| Besoin | Fichier | Fonction |
|--------|---------|----------|
| Ajouter un port | ProcessMonitor.swift | `detectServers()` |
| Modifier détection agents | ProcessMonitor.swift | `detectClaudeInteractive()` etc. |
| Modifier UI section | MonitorView.swift | `AgentsSection`, `ServersSection` etc. |
| Modifier indicateur status | ProcessMonitor.swift | `MonitorSnapshot.statusIndicator` |
| Modifier intervalle refresh | ClaudeMonitorApp.swift | `refreshTimer` (30s) |

## Dashboard

Le bouton "Lancer Dashboard" :
1. Lance `npm run dev:all` en background (processus détaché)
2. Attend que le serveur soit prêt (port 3120)
3. Ouvre automatiquement http://localhost:3120

Le bouton "Stop" arrête proprement le serveur (ports 3120/3121).

## Prérequis

- macOS 13+
- Node.js + npm (pour le dashboard)
- ai-dashboard installé dans `~/ai-dashboard`
