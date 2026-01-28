# AI Dashboard - Ports

Ce projet utilise les ports suivants :

| Port | Service | Description |
|------|---------|-------------|
| 3120 | Vite Dev | Frontend React app |
| 3121 | Express API | Backend (system metrics, process stats, events) |
| 4319 | OTLP Collector | OpenTelemetry collector for Claude Code telemetry |

## Ports à éviter (utilisés par d'autres apps)

- 5173, 6173 : Meal Planner
- 3000-3002 : Gaston services

## Documentation complète

Voir la carte complète dans [claude-grid-menubar/PORTS.md](https://github.com/AntMonss/claude-grid/blob/main/PORTS.md)

---

*Ces ports ont été changés depuis 5173/3333/4318 pour éviter les conflits avec meal-planner*
