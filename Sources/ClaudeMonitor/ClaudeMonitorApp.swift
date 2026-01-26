import Cocoa
import SwiftUI

// =============================================================================
// CLAUDE MONITOR - System & Agent Monitoring
// =============================================================================
// Menubar app for monitoring AI agents, servers, and system resources.
// Icon: Snowboarder + status indicator
// =============================================================================

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var popover: NSPopover!
    var processMonitor = ProcessMonitor()
    var refreshTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Create the status bar item
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        if let button = statusItem.button {
            button.title = "🟢"  // Will be updated by monitor
            button.action = #selector(togglePopover)
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        // Create popover
        let contentView = MonitorPopoverView(monitor: processMonitor)
        popover = NSPopover()
        popover.contentSize = NSSize(width: 280, height: 480)
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(rootView: contentView)

        // Delay initial refresh to avoid blocking app launch
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.processMonitor.refresh()
            self?.updateMenuBarTitle()
            self?.warmUpPopover()
        }

        // Start periodic refresh (every 30 seconds)
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 30.0, repeats: true) { [weak self] _ in
            self?.processMonitor.refresh()
            self?.updateMenuBarTitle()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        refreshTimer?.invalidate()
    }

    private func updateMenuBarTitle() {
        guard let button = statusItem.button else { return }

        let snapshot = processMonitor.snapshot
        // Just the status indicator (colored circle)
        button.title = snapshot.statusIndicator
    }

    private func warmUpPopover() {
        guard let button = statusItem.button else { return }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.performClose(nil)
    }

    @objc func togglePopover(_ sender: NSStatusBarButton) {
        showPopover()
    }

    private func showPopover() {
        guard let button = statusItem.button else { return }

        if popover.isShown {
            popover.performClose(nil)
        } else {
            processMonitor.refresh()
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }
}

// MARK: - Monitor Popover View (no tabs)

struct MonitorPopoverView: View {
    @ObservedObject var monitor: ProcessMonitor

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Claude Monitor")
                    .font(.headline)
                Spacer()
                Button(action: { monitor.refresh() }) {
                    Image(systemName: "arrow.clockwise")
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
                .help("Refresh")

                Button(action: { NSApplication.shared.terminate(nil) }) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)

            Divider()
                .padding(.top, 8)

            // Monitor content
            MonitorView(monitor: monitor)
        }
    }
}

@main
struct ClaudeMonitor {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}
