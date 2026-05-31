// animayte · native Rive pet (macOS).
//
// Hosts an editor-authored .riv (served by the daemon) in the SAME floating window the
// pixel pet uses — transparent, always-on-top, click-through — and drives the Rive state
// machine's contract inputs from /health. One .riv serves both this window and the web page.
//
// This mirrors lib/rive/contract.mjs (keep the index tables in sync) and the window setup
// in desktop/AnimaytePet.swift. Build with the Rive SPM dep: `swift build -c release`.
//
// NOTE: verify the RiveViewModel API against your pinned rive-ios version
// (https://github.com/rive-app/rive-ios) — method names (setInput/triggerInput/
// createRiveView) are stable across recent majors but worth a glance.

import Cocoa
import RiveRuntime

// ── contract mirror (lib/rive/contract.mjs) ──────────────────────────────────
let MOODS = ["neutral", "thinking", "happy", "excited", "oops", "embarrassed", "sad", "sleepy"]
let MOOD_ALIAS = ["idle": "neutral", "working": "thinking", "listening": "thinking", "bashful": "oops", "tired": "sleepy"]
let TOOLS = ["none", "read", "search", "edit", "run", "test", "install", "git", "fetch", "plan"]
func moodIndex(_ m: String) -> Double { Double(MOODS.firstIndex(of: MOOD_ALIAS[m] ?? m) ?? 0) }
func toolIndex(_ t: String) -> Double { Double(TOOLS.firstIndex(of: t) ?? 0) }

let env = ProcessInfo.processInfo.environment
let port = env["ANIMAYTE_PORT"] ?? "4321"
let pet = env["ANIMAYTE_PET"] ?? "slime"
let clickThrough = (env["ANIMAYTE_CLICKTHROUGH"] ?? "1") != "0"

// ── load the .riv from the daemon (already serving application/octet-stream) ──
let riveURL = "http://127.0.0.1:\(port)/pets/\(pet)/pet.riv"
let rvm = RiveViewModel(webURL: riveURL, stateMachineName: "animayte", artboardName: "Pet")

// ── window (mirrors desktop/AnimaytePet.swift) ───────────────────────────────
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
let winW: CGFloat = 220, winH: CGFloat = 240
let origin = NSPoint(x: screen.maxX - winW - 36, y: screen.maxY - winH - 24)
let panel = NSPanel(
    contentRect: NSRect(x: origin.x, y: origin.y, width: winW, height: winH),
    styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
panel.isFloatingPanel = true
panel.level = .floating
panel.backgroundColor = .clear
panel.isOpaque = false
panel.hasShadow = false
panel.isMovableByWindowBackground = true
panel.hidesOnDeactivate = false
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
panel.ignoresMouseEvents = clickThrough

// host the Rive view (transparent background so the desktop shows through)
let riveView = rvm.createRiveView()
riveView.frame = NSRect(x: 0, y: 0, width: winW, height: winH)
riveView.layer?.backgroundColor = NSColor.clear.cgColor
panel.contentView = riveView
panel.orderFrontRegardless()

// ── drive the contract inputs from /health (edge-detect triggers) ────────────
final class Last { var mood = ""; var tool = ""; var reliefSeq = -1; var phase = "alive"; var moodLabel = "" }
let last = Last()

func setNum(_ name: String, _ v: Double) { rvm.setInput(name, value: v) }
func setBool(_ name: String, _ v: Bool) { rvm.setInput(name, value: v) }
func fire(_ name: String) { rvm.triggerInput(name) }

func poll() {
    guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return }
    var req = URLRequest(url: url); req.timeoutInterval = 1.2
    URLSession.shared.dataTask(with: req) { data, _, _ in
        guard let data = data,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let st = obj["state"] as? [String: Any] else { return }
        DispatchQueue.main.async {
            let mood = (st["mood"] as? String) ?? "idle"
            let tool = (st["activeTool"] as? String) ?? "none"
            let fullness = (st["fullness"] as? NSNumber)?.doubleValue ?? 0
            let birds = (st["birds"] as? [Any])?.count ?? 0
            let phase = (st["phase"] as? String) ?? "alive"
            let moodLevel = (st["moodLevel"] as? NSNumber)?.doubleValue ?? 0
            let reliefSeq = (st["reliefSeq"] as? NSNumber)?.intValue ?? 0

            // continuous values
            setNum("mood", moodIndex(mood))
            setNum("fullness", min(100, max(0, fullness * 100)))
            setNum("tool", toolIndex(tool))
            setNum("birds", Double(min(5, birds)))
            setNum("moodLevel", max(-100, min(100, moodLevel * 100)))
            setBool("sleeping", phase == "sleeping")

            // edge-triggered one-shots (poll is stateless, so fire only on change)
            if reliefSeq != last.reliefSeq { if last.reliefSeq >= 0 { fire("compact") }; last.reliefSeq = reliefSeq }
            if phase == "alive" && last.phase == "sleeping" { fire("wake") }
            last.phase = phase
            if mood != last.mood {
                let canon = MOOD_ALIAS[mood] ?? mood
                if canon == "excited" { fire("win") }
                else if canon == "happy" || canon == "oops" { fire("react") }
                else if canon == "sad" { fire("error") }
                last.mood = mood
            }
        }
    }.resume()
}

poll()
let pollTimer = Timer(timeInterval: 1.0, repeats: true) { _ in poll() }
RunLoop.main.add(pollTimer, forMode: .common)

// right-click to dismiss (basic) — extend with the drag/persist behaviour from AnimaytePet.swift as desired
app.run()
