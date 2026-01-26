import SwiftUI

// =============================================================================
// MONITOR VIEW
// =============================================================================
// SwiftUI view for the Monitoring popover.
// Shows agents, servers, Ralph status, orphans, system stats, and dashboard.
// =============================================================================

struct MonitorView: View {
    @ObservedObject var monitor: ProcessMonitor

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                // Agents Section
                AgentsSection(snapshot: monitor.snapshot, onStopAgent: monitor.stopAgent)

                Divider()

                // Servers Section
                ServersSection(snapshot: monitor.snapshot, onStop: monitor.stopServer)

                Divider()

                // Ralph Section
                RalphSection(snapshot: monitor.snapshot, onStop: monitor.stopRalph, onRemoveCron: monitor.removeCron)

                Divider()

                // Orphans Section
                OrphansSection(snapshot: monitor.snapshot, onKill: monitor.killOrphan, onKillAll: monitor.killAllOrphans)

                Divider()

                // System Section
                SystemSection(snapshot: monitor.snapshot)

                Divider()

                // Dashboard Section
                DashboardSection(monitor: monitor)
            }
            .padding(12)
        }
        .frame(width: 280, height: 430)
    }
}

// MARK: - Agents Section

struct AgentsSection: View {
    let snapshot: MonitorSnapshot
    let onStopAgent: (Int) -> Void

    private var hasAgents: Bool {
        snapshot.totalMainAgents + snapshot.totalSubagents + snapshot.totalWorkers > 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "sparkles")
                    .foregroundColor(hasAgents ? .orange : .secondary)
                Text("Agents")
                    .font(.headline)
                    .foregroundColor(hasAgents ? .primary : .secondary)
                Spacer()
                if hasAgents {
                    Text("\(snapshot.totalMainAgents + snapshot.totalSubagents)")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }

            // Claude Interactive
            AgentRow(
                label: "Claude",
                count: snapshot.claudeInteractive.count,
                agents: snapshot.claudeInteractive,
                color: Color(red: 0.85, green: 0.45, blue: 0.25),
                onStop: onStopAgent
            )

            // Claude Subagents
            AgentRow(
                label: "Subagents",
                count: snapshot.claudeSubagents.count,
                agents: snapshot.claudeSubagents,
                color: Color(red: 0.85, green: 0.45, blue: 0.25).opacity(0.7),
                onStop: onStopAgent
            )

            // Claude Workers
            AgentRow(
                label: "Workers",
                count: snapshot.claudeWorkers.count,
                agents: snapshot.claudeWorkers,
                color: Color(red: 0.85, green: 0.45, blue: 0.25).opacity(0.5),
                onStop: onStopAgent
            )

            // Codex
            AgentRow(
                label: "Codex",
                count: snapshot.codexSessions.count,
                agents: snapshot.codexSessions,
                color: Color(red: 0.4, green: 0.6, blue: 0.9),
                onStop: onStopAgent
            )
        }
    }
}

struct AgentRow: View {
    let label: String
    let count: Int
    let agents: [AgentInfo]
    let color: Color
    let onStop: (Int) -> Void

    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label)
                    .font(.subheadline)
                    .foregroundColor(count > 0 ? .primary : .secondary)
                Spacer()
                if count > 0 {
                    Text("×\(count)")
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundColor(color)

                    Button(action: { isExpanded.toggle() }) {
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                    .buttonStyle(.plain)
                } else {
                    Text("—")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .padding(.leading, 20)

            if isExpanded && count > 0 {
                ForEach(agents) { agent in
                    HStack {
                        Text(agent.tty == "??" ? "bg" : agent.tty)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(.secondary)
                        Text("⏱\(agent.elapsedTime)")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(.secondary)
                        Spacer()
                        Button(action: { onStop(agent.pid) }) {
                            Text("Stop")
                                .font(.caption2)
                                .foregroundColor(.red)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.leading, 40)
                }
            }
        }
    }
}

// MARK: - Servers Section

struct ServersSection: View {
    let snapshot: MonitorSnapshot
    let onStop: (Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "server.rack")
                    .foregroundColor(snapshot.activeServers > 0 ? .green : .secondary)
                Text("Serveurs")
                    .font(.headline)
                    .foregroundColor(snapshot.activeServers > 0 ? .primary : .secondary)
                Spacer()
                if snapshot.activeServers > 0 {
                    Text("\(snapshot.activeServers)")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }

            ForEach(snapshot.servers) { server in
                HStack {
                    Circle()
                        .fill(server.isRunning ? Color.green : Color.secondary.opacity(0.3))
                        .frame(width: 8, height: 8)

                    Text(":\(server.port)")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(server.isRunning ? .primary : .secondary)

                    Text(server.name)
                        .font(.caption)
                        .foregroundColor(.secondary)

                    Spacer()

                    if server.isRunning {
                        Button(action: { onStop(server.port) }) {
                            Text("Stop")
                                .font(.caption2)
                                .foregroundColor(.red)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.leading, 20)
            }
        }
    }
}

// MARK: - Ralph Section

struct RalphSection: View {
    let snapshot: MonitorSnapshot
    let onStop: () -> Void
    let onRemoveCron: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .foregroundColor(snapshot.ralph.isRunning ? .blue : .secondary)
                Text("Ralph")
                    .font(.headline)
                    .foregroundColor(snapshot.ralph.isRunning ? .primary : .secondary)
                Spacer()
                if snapshot.ralph.isRunning {
                    Text(snapshot.ralph.progressString)
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundColor(.blue)
                }
            }

            if snapshot.ralph.isRunning {
                HStack {
                    if let etime = snapshot.ralph.elapsedTime {
                        Text("⏱\(etime)")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(.secondary)
                    }
                    Spacer()
                    Button(action: onStop) {
                        Text("Stop")
                            .font(.caption2)
                            .foregroundColor(.orange)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.leading, 20)
            }

            // Cron status
            if snapshot.ralph.hasCron {
                HStack {
                    Image(systemName: "clock")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                    Text("Cron actif")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    if let expires = snapshot.ralph.cronExpiresIn {
                        Text("· \(expires)")
                            .font(.caption)
                            .foregroundColor(expires == "expiré" ? .orange : .secondary)
                    }
                    Spacer()
                    Button(action: onRemoveCron) {
                        Text("Supprimer")
                            .font(.caption2)
                            .foregroundColor(.red)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.leading, 20)
            } else if !snapshot.ralph.isRunning {
                Text("—")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .padding(.leading, 20)
            }
        }
    }
}

// MARK: - Orphans Section

struct OrphansSection: View {
    let snapshot: MonitorSnapshot
    let onKill: (Int) -> Void
    let onKillAll: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "exclamationmark.triangle")
                    .foregroundColor(snapshot.hasOrphans ? .red : .secondary)
                Text("Orphelins")
                    .font(.headline)
                    .foregroundColor(snapshot.hasOrphans ? .primary : .secondary)
                Spacer()
                if snapshot.hasOrphans {
                    Text("×\(snapshot.orphans.count)")
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundColor(.red)
                }
            }

            if snapshot.hasOrphans {
                ForEach(snapshot.orphans) { orphan in
                    HStack {
                        Text(orphan.name)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(.primary)
                        Text("⏱\(orphan.elapsedTime)")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(.secondary)
                        Spacer()
                        Button(action: { onKill(orphan.pid) }) {
                            Text("Kill")
                                .font(.caption2)
                                .foregroundColor(.red)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.leading, 20)
                }

                HStack {
                    Spacer()
                    Button(action: onKillAll) {
                        Label("Cleanup all", systemImage: "trash")
                            .font(.caption)
                    }
                    .buttonStyle(.bordered)
                    .tint(.red)
                }
                .padding(.top, 4)
            } else {
                Text("—")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .padding(.leading, 20)
            }
        }
    }
}

// MARK: - System Section

struct SystemSection: View {
    let snapshot: MonitorSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "gearshape")
                    .foregroundColor(.secondary)
                Text("Système")
                    .font(.headline)
            }

            HStack {
                Text("RAM")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Spacer()
                Text("\(snapshot.system.memoryUsedPercent)%")
                    .font(.system(size: 11, design: .monospaced))
                    .fontWeight(.medium)
                    .foregroundColor(snapshot.system.memoryUsedPercent > 80 ? .orange : .primary)
            }
            .padding(.leading, 20)

            HStack {
                Text("CPU")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Spacer()
                Text(String(format: "%.1f%%", snapshot.system.cpuUserPercent))
                    .font(.system(size: 11, design: .monospaced))
                    .fontWeight(.medium)
                    .foregroundColor(snapshot.system.cpuUserPercent > 70 ? .orange : .primary)
            }
            .padding(.leading, 20)
        }
    }
}

// MARK: - Dashboard Section

struct DashboardSection: View {
    @ObservedObject var monitor: ProcessMonitor
    @State private var isDashboardRunning = false
    @State private var isStarting = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "chart.bar.xaxis")
                    .foregroundColor(isDashboardRunning ? .green : .secondary)
                Text("Dashboard")
                    .font(.headline)
                    .foregroundColor(isDashboardRunning ? .primary : .secondary)
                Spacer()
                if isDashboardRunning {
                    Text(":3120")
                        .font(.caption)
                        .foregroundColor(.green)
                }
            }

            if isDashboardRunning {
                HStack(spacing: 8) {
                    Button(action: monitor.openDashboard) {
                        Label("Ouvrir", systemImage: "safari")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.blue)

                    Button(action: {
                        monitor.stopDashboard()
                        isDashboardRunning = false
                    }) {
                        Label("Stop", systemImage: "stop.fill")
                    }
                    .buttonStyle(.bordered)
                    .tint(.red)
                }
                .padding(.leading, 20)
            } else {
                Button(action: {
                    isStarting = true
                    monitor.startDashboard {
                        DispatchQueue.main.async {
                            isStarting = false
                            isDashboardRunning = monitor.isDashboardRunning()
                        }
                    }
                }) {
                    if isStarting {
                        HStack {
                            ProgressView()
                                .scaleEffect(0.7)
                            Text("Démarrage...")
                        }
                        .frame(maxWidth: .infinity)
                    } else {
                        Label("Lancer Dashboard", systemImage: "play.fill")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(.green)
                .disabled(isStarting)
                .padding(.leading, 20)

                Text("Lance le serveur et ouvre le navigateur")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .padding(.leading, 20)
            }
        }
        .onAppear {
            isDashboardRunning = monitor.isDashboardRunning()
        }
    }
}
