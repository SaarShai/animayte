// animayte — native floating desktop pet (macOS / AppKit).
// Borderless, transparent, always-on-top NSPanel that follows you across Spaces,
// renders our pixel slime, and reacts to the live session via the daemon /health.
//
// SIGNATURE FEATURE (context → body):
//   • below 60% context: calm, normal size.
//   • above 60%: for each +5%, the HEAD swells a step bigger AND forehead sweat increases.
//   • on /compact: dramatic relief — the swollen head deflates back to normal and
//     STEAM puffs from the sides ("ears").
//
// Build:  swiftc -O AnimaytePet.swift -o .build/AnimaytePet
// Env:    ANIMAYTE_ASSETS, ANIMAYTE_PORT, ANIMAYTE_CLICKTHROUGH=1

import Cocoa

// ---------- shared state (updated by the poller, read by the view) ----------
final class PetState {
    let lock = NSLock()
    var mood = "idle"
    var fullness: Double = 0.12
    var phase = "alive"
    var birds = 0
    var reliefSeq = 0          // bumped by the daemon on /compact
}
let state = PetState()

let env = ProcessInfo.processInfo.environment
let assetsDir = env["ANIMAYTE_ASSETS"] ?? (FileManager.default.currentDirectoryPath + "/assets")
let port = env["ANIMAYTE_PORT"] ?? "4321"
let clickThrough = env["ANIMAYTE_CLICKTHROUGH"] == "1"

func loadImg(_ name: String) -> NSImage? { NSImage(contentsOfFile: "\(assetsDir)/\(name)") }
let slime = loadImg("slime.png")
let birdImg = loadImg("bird.png")

let CELL: CGFloat = 64
let FRAMES = 4
let ROWS = 8   // dictionary order: neutral, thinking, happy, excited, oops, embarrassed, sad, sleepy
func moodRow(_ m: String) -> Int {
    switch m {
    case "neutral", "idle":                   return 0
    case "thinking", "working", "listening":  return 1
    case "happy":                             return 2
    case "excited":                           return 3
    case "oops", "bashful":                   return 4
    case "embarrassed":                       return 5
    case "sad":                               return 6
    case "sleepy", "tired":                   return 7
    default:                                  return 0
    }
}

// ---------- the pet view ----------
final class PetView: NSView {
    var t: Double = 0
    var shownFullness: Double = 0.12     // smoothed toward state.fullness (so deflation is fluid)
    var lastReliefSeq = 0
    var reliefStart: Double = -100        // view-clock time when the last relief began
    var creatureRect: NSRect = .zero      // where the slime is actually drawn (for click-through)

    // CLICK-THROUGH: only the creature's own footprint grabs the mouse; clicks on the
    // transparent area pass straight through to whatever app is underneath.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let p = NSPoint(x: point.x - frame.minX, y: point.y - frame.minY)   // → view-local
        return creatureRect.insetBy(dx: -6, dy: -6).contains(p) ? self : nil
    }

    private func fillDrop(_ x: CGFloat, _ y: CGFloat, _ s: CGFloat, _ color: NSColor) {
        color.setFill()
        NSBezierPath(ovalIn: NSRect(x: x - s/2, y: y - s/2, width: s, height: s * 1.25)).fill()
    }

    override func draw(_ dirtyRect: NSRect) {
        NSGraphicsContext.current?.imageInterpolation = .none
        let W = bounds.width, H = bounds.height
        _ = H

        state.lock.lock()
        let mood = state.phase == "sleeping" ? "sleepy" : state.mood
        let targetFull = state.fullness
        let birds = state.birds
        let reliefSeq = state.reliefSeq
        state.lock.unlock()

        // smooth the fullness so a sudden /compact drop deflates fluidly
        shownFullness += (targetFull - shownFullness) * 0.12
        if reliefSeq != lastReliefSeq { lastReliefSeq = reliefSeq; reliefStart = t }  // start steam

        let pct = shownFullness * 100.0
        let over = max(0.0, pct - 60.0) / 5.0          // 0 at ≤60%, up to 8 at 100%
        let swell = CGFloat(min(over, 8.0)) * 0.05      // head growth, up to ~0.40

        // ---- the slime body (anchored at bottom; head grows upward) ----
        guard let img = slime else { return }
        let row = moodRow(mood)
        let col = Int(t * 5) % FRAMES
        let imgH = CELL * CGFloat(ROWS)
        let src = NSRect(x: CGFloat(col) * CELL, y: imgH - CGFloat(row + 1) * CELL,
                         width: CELL, height: CELL)
        let wob = sin(t * 2.2) * (mood == "working" ? 0.015 : 0.030)
        let base = W * 0.70
        let fw = base * (1 + swell * 0.40) * (1 - CGFloat(wob))
        let fh = base * (1 + swell * 1.00) * (1 + CGFloat(wob))   // head swells more in height
        let slimeBottom: CGFloat = 6
        let slimeRect = NSRect(x: (W - fw)/2, y: slimeBottom, width: fw, height: fh)
        creatureRect = slimeRect                      // remember footprint for click-through hitTest
        img.draw(in: slimeRect, from: src, operation: .sourceOver, fraction: 1.0)
        let headTop = slimeBottom + fh

        // ---- forehead sweat: more beads as context climbs past 60% ----
        let beads = min(5, Int(over.rounded(.down)))
        if beads > 0 {
            let intensity = CGFloat(min(1.0, over / 8.0))
            let foreheadY = slimeBottom + fh * 0.70
            NSColor(calibratedRed: 0.49, green: 0.78, blue: 1.0, alpha: 0.95).setFill()
            for i in 0..<beads {
                let spread = fw * 0.16
                let bx = W/2 + CGFloat(i) * spread - CGFloat(beads - 1) * spread / 2
                let drip = CGFloat((sin(t * 2.4 + Double(i) * 1.7) + 1) / 2) * (4 + intensity * 5)
                let s = 3 + intensity * 2.5
                fillDrop(bx, foreheadY - drip, s, NSColor(calibratedRed: 0.49, green: 0.78, blue: 1.0, alpha: 0.95))
                // little white glint
                NSColor(white: 1, alpha: 0.85).setFill()
                NSBezierPath(ovalIn: NSRect(x: bx - 1, y: foreheadY - drip + s*0.2, width: 1.4, height: 1.4)).fill()
            }
        }

        // ---- /compact relief: STEAM from the sides ("ears") for ~2.5s ----
        let reliefAge = t - reliefStart
        if reliefAge >= 0 && reliefAge < 2.5 {
            let earY = slimeBottom + fh * 0.62
            let fade = min(1.0, (2.5 - reliefAge) / 0.6)
            for side in [-1.0, 1.0] {
                for p in 0..<4 {
                    let prog = ((reliefAge * 0.7 + Double(p) * 0.28).truncatingRemainder(dividingBy: 1.0))
                    let px = W/2 + CGFloat(side) * (fw * 0.46 + CGFloat(prog) * 12)
                    let py = earY + CGFloat(prog) * 46
                    let r = 4 + CGFloat(prog) * 7
                    let a = (1 - prog) * 0.6 * fade
                    NSColor(white: 1.0, alpha: a).setFill()
                    NSBezierPath(ovalIn: NSRect(x: px - r/2, y: py - r/2, width: r, height: r)).fill()
                }
            }
        }

        // ---- orbiting sub-agent birds (in front, in the headroom) ----
        if let b = birdImg, birds > 0 {
            let n = min(birds, 5)
            for i in 0..<n {
                let ang = t * 1.1 + Double(i) / Double(n) * Double.pi * 2
                let cx = W / 2 + CGFloat(cos(ang)) * (W * 0.30)
                let cy = headTop - 6 + CGFloat(sin(ang)) * 12
                let fr = (Int(t * 9) + i) % 2
                let s: CGFloat = 26
                let bsrc = NSRect(x: CGFloat(fr) * 24, y: 0, width: 24, height: 24)
                b.draw(in: NSRect(x: cx - s/2, y: cy - s/2, width: s, height: s),
                       from: bsrc, operation: .sourceOver, fraction: 1.0)
            }
        }
    }

    override func rightMouseDown(with event: NSEvent) {
        let menu = NSMenu()
        let item = NSMenuItem(title: "Dismiss animayte",
                              action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        item.target = NSApp
        menu.addItem(item)
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }
}

// ---------- remembered position (~/.animayte/petpos.json) ----------
let posFile: URL = {
    let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".animayte")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("petpos.json")
}()
func loadSavedOrigin() -> NSPoint? {
    guard let data = try? Data(contentsOf: posFile),
          let o = try? JSONSerialization.jsonObject(with: data) as? [String: Double],
          let x = o["x"], let y = o["y"] else { return nil }
    return NSPoint(x: x, y: y)
}
func saveOrigin(_ p: NSPoint) {
    if let data = try? JSONSerialization.data(withJSONObject: ["x": p.x, "y": p.y]) {
        try? data.write(to: posFile)
    }
}

// ---------- app / window ----------
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
let winW: CGFloat = 190, winH: CGFloat = 250   // extra headroom for the swollen head + steam
let defaultOrigin = NSPoint(x: screen.maxX - winW - 36, y: screen.maxY - winH - 24)
let startOrigin = loadSavedOrigin() ?? defaultOrigin
let panel = NSPanel(
    contentRect: NSRect(x: startOrigin.x, y: startOrigin.y, width: winW, height: winH),
    styleMask: [.borderless, .nonactivatingPanel],
    backing: .buffered, defer: false)
panel.isFloatingPanel = true
panel.level = .floating
panel.backgroundColor = .clear
panel.isOpaque = false
panel.hasShadow = false
panel.isMovableByWindowBackground = true
panel.hidesOnDeactivate = false
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
panel.ignoresMouseEvents = clickThrough

let view = PetView(frame: NSRect(x: 0, y: 0, width: winW, height: winH))
panel.contentView = view
panel.orderFrontRegardless()

// persist position whenever the user drags the pet
let moveObserver = NotificationCenter.default.addObserver(
    forName: NSWindow.didMoveNotification, object: panel, queue: .main) { _ in
    saveOrigin(panel.frame.origin)
}
_ = moveObserver

// ---------- timers (in .common so animation keeps running while dragging) ----------
let animTimer = Timer(timeInterval: 0.06, repeats: true) { _ in
    view.t += 0.06
    view.needsDisplay = true
}
RunLoop.main.add(animTimer, forMode: .common)

func poll() {
    guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { return }
    var req = URLRequest(url: url)
    req.timeoutInterval = 1.2
    URLSession.shared.dataTask(with: req) { data, _, _ in
        guard let data = data,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let st = obj["state"] as? [String: Any] else { return }
        state.lock.lock()
        if let m = st["mood"] as? String { state.mood = m }
        if let f = st["fullness"] as? NSNumber { state.fullness = f.doubleValue }
        if let p = st["phase"] as? String { state.phase = p }
        if let b = st["birds"] as? [Any] { state.birds = b.count }
        if let r = st["reliefSeq"] as? NSNumber { state.reliefSeq = r.intValue }
        state.lock.unlock()
    }.resume()
}
poll()
let pollTimer = Timer(timeInterval: 1.5, repeats: true) { _ in poll() }
RunLoop.main.add(pollTimer, forMode: .common)

app.run()
