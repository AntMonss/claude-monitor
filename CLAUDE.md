# Claude Monitor - System & Agent Monitoring

## PRINCIPE FONDAMENTAL

**Le monitor ne doit JAMAIS faire partie du problème.**

Toute modification doit respecter ces contraintes absolues :
- **Zero impact CPU** : Pas de polling agressif, pas de boucles coûteuses, pas de calculs lourds
- **Mémoire minimale** : Pas de stockage de données historiques volumineuses, pas de caches qui grossissent
- **I/O légères** : Commandes shell espacées (30s min), pas de lecture de fichiers en continu
- **Réactivité** : L'app doit rester fluide même quand le système est sous charge

Si une feature risque d'alourdir le système, elle ne doit pas être implémentée ou doit être opt-in avec avertissement.

---

## Architecture

**Menubar (Swift)** = Indicateur léger + actions rapides
**Dashboard (React)** = Diagnostics, tooltips, graphiques, sessions

Le menubar reste minimal. Toute l'intelligence est dans le dashboard.

## Menubar (ce projet)

Indicateur de status dans la menubar (rond de couleur) :
- 🟢 Tout va bien
- 🟡 Attention modérée (mémoire >75%, >3 agents)
- 🟠 Attention (mémoire >85%, >6 agents)
- 🔴 Problème (orphelins détectés)

### Fonctionnalités

- **Agents** : Claude interactifs, subagents, workers, Codex
- **Serveurs** : Ports 3000, 3001, 3002, 3120 avec bouton Stop
- **Ralph** : Progression, temps écoulé, cron, bouton Stop
- **Orphelins** : Liste avec Kill individuel + Cleanup all
- **Système** : RAM%, CPU%
- **Dashboard** : Lancement automatique en background + ouverture navigateur

### Structure

```
Sources/ClaudeMonitor/
├── ClaudeMonitorApp.swift   # Point d'entrée, menubar
├── MonitorView.swift        # UI monitoring (sections)
└── ProcessMonitor.swift     # Détection processus + actions

dashboard/                   # Web UI (React/Vite)
├── src/                     # Frontend React
├── server.mjs               # Backend API
└── scripts/                 # Collectors
```

### Commandes

```bash
# Build et run
./run.sh

# Ou manuellement
swift build && .build/debug/ClaudeMonitor
```

### Points d'entrée

| Besoin | Fichier | Fonction |
|--------|---------|----------|
| Ajouter un port | ProcessMonitor.swift | `detectServers()` |
| Modifier détection agents | ProcessMonitor.swift | `detectClaudeInteractive()` etc. |
| Modifier UI section | MonitorView.swift | `AgentsSection`, `ServersSection` etc. |
| Modifier indicateur status | ProcessMonitor.swift | `MonitorSnapshot.statusIndicator` |
| Modifier intervalle refresh | ClaudeMonitorApp.swift | `refreshTimer` (30s) |

## Dashboard (./dashboard)

Toutes les fonctionnalités avancées sont dans le dashboard :

- **Diagnostics** : CPU, RAM, Swap, Réseau avec analyse de cause probable
- **Tooltips explicatifs** : Hover sur les cartes = explication + causes possibles
- **Diagnostic Claude** : Bouton pour analyse approfondie via Claude CLI
- **Sessions Claude Code** : Lecture des JSONL de `~/.claude/projects/`
- **Process stats** : CPU/RAM par process (collector)
- **Timeline** : Événements unifiés

### Tooltips Explicatifs

Chaque carte de diagnostic affiche un tooltip au hover avec :
- **C'est quoi ?** : Explication simple de la métrique
- **Pourquoi c'est jaune/rouge ?** : Le problème concret
- **Conséquences** : Ce que ça implique
- **Causes possibles** : D'où ça peut venir

Métriques documentées : `cpu`, `memory`, `swap`, `claude-api`, `local-ratio`, `local-session`, `local-tasks`

### Diagnostic Claude (bouton)

Le bouton "Diagnostic Claude" dans le panneau de diagnostic :
1. Collecte toutes les données actuelles (CPU, RAM, Swap, Réseau, Latence API, Session, Patterns)
2. Appelle Claude CLI en mode non-interactif (`claude -p --output-format json`)
3. Affiche l'analyse dans une modal

**Données envoyées à Claude** :
- Système : CPU%, RAM%, Swap, Réseau (↓/↑)
- API Claude : Latence dernière requête + moyenne (via OTEL)
- Session : Durée, messages, ratio message/tool
- Top 5 processus gourmands
- Patterns détectés

**Timeout** : 60 secondes

### Sessions Claude Code

Le dashboard lit directement les fichiers JSONL de `~/.claude/projects/`.

- **Zero config** : Pas besoin d'OTEL, les données sont déjà là
- **Zero overhead** : Lecture à la demande (dernières 1000 lignes max)
- **Historique** : Sessions des dernières 24h

### Intervalles de collecte

| Collector | Intervalle | Justification |
|-----------|------------|---------------|
| `collector.mjs` (système) | 10s | Évite surcharge CPU |
| `claude-local-collector.mjs` | 30s | Lecture fichiers légère |
| `latency-monitor.mjs` | 10s | Réseau externe uniquement |
| Frontend polling | 5s | UI réactive |

### Rotation des fichiers

Tous les fichiers JSONL sont limités à **500 lignes max** (rotation toutes les 5 min).
Taille totale max : ~700 KB.

## Prérequis

- macOS 13+
- Node.js + npm (pour le dashboard)

## Installation du dashboard

```bash
cd dashboard && npm install
```
