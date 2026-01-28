import Foundation
import AppKit

// =============================================================================
// PROCESS MONITOR
// =============================================================================
// Detects running AI agents, dev servers, orphan processes, and system stats.
// Ported from dev-monitor.2m.sh (xbar plugin) to native Swift.
// =============================================================================

// MARK: - Data Models

struct AgentInfo: Identifiable {
    let id = UUID()
    let pid: Int
    let tty: String
    let elapsedTime: String
    let type: AgentType

    enum AgentType: String {
        case claudeInteractive = "Claude"
        case claudeSubagent = "Subagent"
        case claudeWorker = "Worker"
        case codex = "Codex"
        case codexSubagent = "Codex Sub"
    }
}

struct ServerInfo: Identifiable {
    let id = UUID()
    let port: Int
    let name: String
    let processName: String
    let isRunning: Bool
}

struct RalphInfo {
    let isRunning: Bool
    let currentIteration: Int?
    let maxIterations: Int?
    let elapsedTime: String?
    let hasCron: Bool
    let cronExpiresIn: String?

    var progressString: String {
        guard isRunning, let current = currentIteration, let max = maxIterations else {
            return "—"
        }
        return "\(current)/\(max)"
    }
}

struct OrphanProcess: Identifiable {
    let id = UUID()
    let pid: Int
    let name: String
    let elapsedTime: String
    let category: String // chokidar, esbuild, claude, mcp, concurrently
}

struct SystemStats {
    let memoryUsedPercent: Int
    let cpuUserPercent: Double
}

struct MonitorSnapshot {
    let timestamp: Date

    // Agents
    let claudeInteractive: [AgentInfo]
    let claudeSubagents: [AgentInfo]
    let claudeWorkers: [AgentInfo]
    let codexSessions: [AgentInfo]
    let codexSubagents: [AgentInfo]

    // Infrastructure
    let servers: [ServerInfo]
    let ralph: RalphInfo
    let orphans: [OrphanProcess]
    let system: SystemStats

    // Computed properties for menu bar display
    var totalMainAgents: Int {
        claudeInteractive.count + codexSessions.count
    }

    var totalSubagents: Int {
        claudeSubagents.count + codexSubagents.count
    }

    var totalWorkers: Int {
        claudeWorkers.count
    }

    var activeServers: Int {
        servers.filter { $0.isRunning }.count
    }

    var hasOrphans: Bool {
        !orphans.isEmpty
    }

    var menuBarTitle: String {
        // Just return the status indicator emoji
        return statusIndicator
    }

    /// Total of all agents (main + subagents + workers)
    var totalAllAgents: Int {
        totalMainAgents + totalSubagents + totalWorkers
    }

    /// Status indicator: 🟢 = all good, 🟡 = minor, 🟠 = attention, 🔴 = problem
    var statusIndicator: String {
        // Red: orphans detected
        if hasOrphans {
            return "🔴"
        }

        // Orange: high memory (>85%) or many agents (>6)
        if system.memoryUsedPercent > 85 || totalAllAgents > 6 {
            return "🟠"
        }

        // Yellow: moderate memory (>75%) or several agents (>3)
        if system.memoryUsedPercent > 75 || totalAllAgents > 3 {
            return "🟡"
        }

        // Green: all good
        return "🟢"
    }
}

// MARK: - Process Monitor

class ProcessMonitor: ObservableObject {
    @Published var snapshot: MonitorSnapshot

    private let homeDir: String

    init() {
        self.homeDir = FileManager.default.homeDirectoryForCurrentUser.path
        self.snapshot = MonitorSnapshot(
            timestamp: Date(),
            claudeInteractive: [],
            claudeSubagents: [],
            claudeWorkers: [],
            codexSessions: [],
            codexSubagents: [],
            servers: [],
            ralph: RalphInfo(isRunning: false, currentIteration: nil, maxIterations: nil, elapsedTime: nil, hasCron: false, cronExpiresIn: nil),
            orphans: [],
            system: SystemStats(memoryUsedPercent: 0, cpuUserPercent: 0)
        )
    }

    /// Refreshes all monitoring data
    func refresh() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }

            let newSnapshot = MonitorSnapshot(
                timestamp: Date(),
                claudeInteractive: self.detectClaudeInteractive(),
                claudeSubagents: self.detectClaudeSubagents(),
                claudeWorkers: self.detectClaudeWorkers(),
                codexSessions: self.detectCodexSessions(),
                codexSubagents: self.detectCodexSubagents(),
                servers: self.detectServers(),
                ralph: self.detectRalph(),
                orphans: self.detectOrphans(),
                system: self.getSystemStats()
            )

            DispatchQueue.main.async {
                self.snapshot = newSnapshot
            }
        }
    }

    // MARK: - Agent Detection

    private func detectClaudeInteractive() -> [AgentInfo] {
        // Claude interactive = has TTY (not "??"), running claude with --dangerously or from .local/bin/claude
        let output = shell("ps -eo pid,tty,etime,command | grep -E 'claude.*--dangerously|\\.local/bin/claude' | grep -v grep | grep -v ' \\?\\? '")
        return parseAgents(output, type: .claudeInteractive)
    }

    private func detectClaudeSubagents() -> [AgentInfo] {
        // Claude subagents = background (TTY=??), with --max-turns (spawned by Task tool)
        let output = shell("ps -eo pid,tty,etime,command | grep -E 'claude.*--dangerously|\\.local/bin/claude|\\.local/share/claude/versions' | grep -v grep | grep ' \\?\\? ' | grep -v 'chrome-native-host' | grep 'max-turns'")
        return parseAgents(output, type: .claudeSubagent)
    }

    private func detectClaudeWorkers() -> [AgentInfo] {
        // Claude background workers = background (TTY=??), no --max-turns (Ralph workers etc)
        let output = shell("ps -eo pid,tty,etime,command | grep -E 'claude.*--dangerously|\\.local/bin/claude|\\.local/share/claude/versions' | grep -v grep | grep ' \\?\\? ' | grep -v 'chrome-native-host' | grep -v 'max-turns'")
        return parseAgents(output, type: .claudeWorker)
    }

    private func detectCodexSessions() -> [AgentInfo] {
        // Codex sessions with TTY (interactive)
        let output = shell("ps -eo pid,tty,etime,command | grep -E 'codex' | grep -v grep | grep -v 'node_modules' | grep -v ' \\?\\? '")
        return parseAgents(output, type: .codex)
    }

    private func detectCodexSubagents() -> [AgentInfo] {
        // Codex subagents (background, TTY=??)
        let output = shell("ps -eo pid,tty,etime,command | grep -E 'codex' | grep -v grep | grep -v 'node_modules' | grep ' \\?\\? '")
        return parseAgents(output, type: .codexSubagent)
    }

    private func parseAgents(_ output: String, type: AgentInfo.AgentType) -> [AgentInfo] {
        var agents: [AgentInfo] = []
        let lines = output.split(separator: "\n")

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { continue }

            let parts = trimmed.split(separator: " ", maxSplits: 3, omittingEmptySubsequences: true)
            guard parts.count >= 3 else { continue }

            if let pid = Int(parts[0]) {
                let tty = String(parts[1]).replacingOccurrences(of: "ttys", with: "tty")
                let etime = String(parts[2])
                agents.append(AgentInfo(pid: pid, tty: tty, elapsedTime: etime, type: type))
            }
        }

        return agents
    }

    // MARK: - Server Detection

    private func detectServers() -> [ServerInfo] {
        let ports: [(port: Int, name: String)] = [
            (3000, "dev"),
            (3001, "gaston-fe"),
            (3002, "gaston-be"),
            (3120, "dashboard")
        ]

        return ports.map { portInfo in
            let output = shell("lsof -i :\(portInfo.port) -sTCP:LISTEN 2>/dev/null | grep -v '^COMMAND' | head -1 | awk '{print $1}'")
            let processName = output.trimmingCharacters(in: .whitespacesAndNewlines)
            let isRunning = !processName.isEmpty

            return ServerInfo(
                port: portInfo.port,
                name: portInfo.name,
                processName: processName,
                isRunning: isRunning
            )
        }
    }

    // MARK: - Ralph Detection

    private func detectRalph() -> RalphInfo {
        // Check if ralph.sh is running
        let ralphOutput = shell("ps -eo pid,etime,command | grep 'ralph.sh' | grep -v grep")
        let isRunning = !ralphOutput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

        var currentIteration: Int?
        var maxIterations: Int?
        var elapsedTime: String?

        if isRunning {
            // Get max iterations from command line
            let maxOutput = shell("ps -eo command | grep -E 'ralph\\.sh [0-9]+' | grep -v grep | head -1 | sed 's/.*ralph\\.sh \\([0-9]*\\).*/\\1/'")
            maxIterations = Int(maxOutput.trimmingCharacters(in: .whitespacesAndNewlines))

            // Get current iteration from latest log
            let logPath = "\(homeDir)/dev/scripts/ralph/logs"
            let latestLog = shell("ls -t \(logPath)/iter-*.log 2>/dev/null | head -1")
            if !latestLog.isEmpty {
                let logName = URL(fileURLWithPath: latestLog.trimmingCharacters(in: .whitespacesAndNewlines)).lastPathComponent
                // Extract number from iter-0027.log -> 27
                if let match = logName.range(of: "iter-0*(\\d+)", options: .regularExpression) {
                    let numStr = logName[match].replacingOccurrences(of: "iter-", with: "").replacingOccurrences(of: ".log", with: "")
                    currentIteration = Int(numStr.trimmingCharacters(in: CharacterSet(charactersIn: "0"))) ?? Int(numStr)
                }
            }

            // Get elapsed time
            let etimeOutput = shell("ps -eo etime,command | grep 'ralph.sh' | grep -v grep | head -1 | awk '{print $1}'")
            elapsedTime = etimeOutput.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        // Check for cron
        let cronOutput = shell("crontab -l 2>/dev/null | grep 'ralph_cron_check.sh'")
        let hasCron = !cronOutput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

        var cronExpiresIn: String?
        if hasCron {
            let expiresFile = "\(homeDir)/dev/scripts/ralph/.cron_expires"
            if FileManager.default.fileExists(atPath: expiresFile),
               let content = try? String(contentsOfFile: expiresFile, encoding: .utf8),
               let expiresAt = Int(content.trimmingCharacters(in: .whitespacesAndNewlines)) {
                let now = Int(Date().timeIntervalSince1970)
                let remaining = expiresAt - now
                if remaining > 0 {
                    let hours = remaining / 3600
                    let mins = (remaining % 3600) / 60
                    cronExpiresIn = "\(hours)h\(mins)m"
                } else {
                    cronExpiresIn = "expiré"
                }
            }
        }

        return RalphInfo(
            isRunning: isRunning,
            currentIteration: currentIteration,
            maxIterations: maxIterations,
            elapsedTime: elapsedTime.flatMap { $0.isEmpty ? nil : $0 },
            hasCron: hasCron,
            cronExpiresIn: cronExpiresIn
        )
    }

    // MARK: - Orphan Detection

    private func detectOrphans() -> [OrphanProcess] {
        var orphans: [OrphanProcess] = []

        // True orphans have PPID=1
        let categories: [(pattern: String, category: String)] = [
            ("chokidar", "chokidar"),
            ("concurrently", "concurrently"),
            ("esbuild", "esbuild"),
            ("mcp-remote.*REMPLACE_PAR", "mcp")
        ]

        for (pattern, category) in categories {
            let output = shell("ps -eo pid,ppid,etime,command | grep '\(pattern)' | grep -v grep | grep ' \\?\\? ' | awk '$2 == 1'")
            orphans.append(contentsOf: parseOrphans(output, category: category))
        }

        // Claude orphans (special pattern)
        let claudeOrphans = shell("ps -eo pid,ppid,etime,command | grep -E 'claude.*--dangerously|\\.local/bin/claude' | grep -v grep | grep ' \\?\\? ' | awk '$2 == 1'")
        orphans.append(contentsOf: parseOrphans(claudeOrphans, category: "claude"))

        return orphans
    }

    private func parseOrphans(_ output: String, category: String) -> [OrphanProcess] {
        var orphans: [OrphanProcess] = []
        let lines = output.split(separator: "\n")

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { continue }

            let parts = trimmed.split(separator: " ", maxSplits: 3, omittingEmptySubsequences: true)
            guard parts.count >= 3 else { continue }

            if let pid = Int(parts[0]) {
                let etime = String(parts[2])
                // Extract process name from command
                let cmd = parts.count > 3 ? String(parts[3]) : category
                let name = URL(fileURLWithPath: cmd.components(separatedBy: " ").first ?? cmd).lastPathComponent

                orphans.append(OrphanProcess(
                    pid: pid,
                    name: String(name.prefix(15)),
                    elapsedTime: etime,
                    category: category
                ))
            }
        }

        return orphans
    }

    // MARK: - System Stats

    private func getSystemStats() -> SystemStats {
        // Memory calculation (same as xbar script)
        let vmStatOutput = shell("vm_stat")
        let lines = vmStatOutput.split(separator: "\n")

        var pageSize = 4096
        var pagesFree = 0
        var pagesInactive = 0
        var pagesSpeculative = 0

        for line in lines {
            let lineStr = String(line)
            if lineStr.contains("page size") {
                if let match = lineStr.range(of: "\\d+", options: .regularExpression) {
                    pageSize = Int(lineStr[match]) ?? 4096
                }
            } else if lineStr.contains("Pages free") {
                pagesFree = extractPageCount(from: lineStr)
            } else if lineStr.contains("Pages inactive") {
                pagesInactive = extractPageCount(from: lineStr)
            } else if lineStr.contains("Pages speculative") {
                pagesSpeculative = extractPageCount(from: lineStr)
            }
        }

        // Get total memory
        let totalMemOutput = shell("sysctl -n hw.memsize")
        let totalMem = Int(totalMemOutput.trimmingCharacters(in: .whitespacesAndNewlines)) ?? (16 * 1024 * 1024 * 1024)

        // Available = free + inactive + speculative
        let availablePages = pagesFree + pagesInactive + pagesSpeculative
        let availableBytes = availablePages * pageSize
        let memUsedPercent = 100 - (availableBytes * 100 / totalMem)

        // CPU (simplified - just get user%)
        let topOutput = shell("top -l 1 -s 0 | grep 'CPU usage'")
        var cpuUser = 0.0
        if let match = topOutput.range(of: "\\d+\\.?\\d*%", options: .regularExpression) {
            let percentStr = topOutput[match].replacingOccurrences(of: "%", with: "")
            cpuUser = Double(percentStr) ?? 0
        }

        return SystemStats(memoryUsedPercent: memUsedPercent, cpuUserPercent: cpuUser)
    }

    private func extractPageCount(from line: String) -> Int {
        // "Pages free:    12345."
        let parts = line.split(separator: ":")
        guard parts.count > 1 else { return 0 }
        let numStr = parts[1].trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ".", with: "")
        return Int(numStr) ?? 0
    }

    // MARK: - Actions

    func killOrphan(pid: Int) {
        _ = shell("kill -9 \(pid)")
        refresh()
    }

    func killAllOrphans() {
        for orphan in snapshot.orphans {
            _ = shell("kill -9 \(orphan.pid)")
        }
        refresh()
    }

    func stopServer(port: Int) {
        // Use SIGTERM first for graceful shutdown (HMR, sockets cleanup)
        // Then SIGKILL after 2s if still running
        _ = shell("""
            pids=$(lsof -t -i :\(port) 2>/dev/null)
            if [ -n "$pids" ]; then
                echo "$pids" | xargs kill -15 2>/dev/null
                sleep 2
                echo "$pids" | xargs kill -9 2>/dev/null 2>&1
            fi
        """)
        refresh()
    }

    func stopAgent(pid: Int) {
        // Graceful shutdown with SIGTERM, then SIGKILL
        _ = shell("kill -15 \(pid) 2>/dev/null; sleep 1; kill -9 \(pid) 2>/dev/null")
        refresh()
    }

    func stopRalph() {
        _ = shell("pkill -f 'ralph.sh'")
        refresh()
    }

    func removeCron() {
        _ = shell("crontab -l | grep -v ralph_cron_check | crontab -")
        _ = shell("rm -f \(homeDir)/dev/scripts/ralph/.cron_expires \(homeDir)/dev/scripts/ralph/.ralph_running")
        refresh()
    }

    func openDashboard() {
        // Dashboard runs on port 3120 (vite frontend)
        if let url = URL(string: "http://localhost:3120") {
            NSWorkspace.shared.open(url)
        }
    }

    /// Starts the dashboard in background (detached process)
    /// Waits for server to be ready, then opens browser
    func startDashboard(completion: @escaping () -> Void) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }

            // Launch npm run dev:all in background (detached)
            // Source nvm first since Process() doesn't have shell PATH
            let script = """
            export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && cd \(self.homeDir)/dev/claude-monitor/dashboard && nohup npm run dev:all > /tmp/ai-dashboard.log 2>&1 &
            """
            _ = self.shell(script)

            // Wait for server to start (poll every 500ms, max 10s)
            var attempts = 0
            let maxAttempts = 20
            while attempts < maxAttempts {
                Thread.sleep(forTimeInterval: 0.5)
                if self.isDashboardRunning() {
                    // Server is ready, open browser
                    DispatchQueue.main.async {
                        self.openDashboard()
                    }
                    break
                }
                attempts += 1
            }

            completion()
        }
    }

    func isDashboardRunning() -> Bool {
        // Check both Vite dev (3120) and server (3121)
        let vite = shell("lsof -i :3120 -sTCP:LISTEN 2>/dev/null | grep -v '^COMMAND'")
        let server = shell("lsof -i :3121 -sTCP:LISTEN 2>/dev/null | grep -v '^COMMAND'")
        return !vite.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
               !server.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func stopDashboard() {
        // Kill all dashboard-related processes gracefully
        // Vite (3120), Server (3121), and all node processes in ai-dashboard
        _ = shell("""
            # Kill by ports first (graceful)
            lsof -t -i :3120 2>/dev/null | xargs kill -15 2>/dev/null
            lsof -t -i :3121 2>/dev/null | xargs kill -15 2>/dev/null
            sleep 1
            # Force kill if still running
            lsof -t -i :3120 2>/dev/null | xargs kill -9 2>/dev/null
            lsof -t -i :3121 2>/dev/null | xargs kill -9 2>/dev/null
            # Kill any remaining concurrently processes
            pkill -f 'concurrently.*ai-dashboard' 2>/dev/null
        """)
        refresh()
    }

    // MARK: - Shell Helper

    private func shell(_ command: String) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = ["-c", command]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return ""
        }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8) ?? ""
    }
}
