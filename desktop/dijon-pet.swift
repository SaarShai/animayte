// animayte — native floating "Dijon" pet (macOS / AppKit + WebKit).
//
// A transparent, borderless, always-on-top NSPanel hosting a WKWebView that loads the
// daemon's grid overlay (/grid/pet.html). Dijon is rendered by the shared zero-dep grid
// runtime running in the web engine — so there is ONE renderer (grid/*.mjs), never a
// re-implementation in Swift. It reacts to the live session via the daemon's SSE, exactly
// like the browser overlay. Reuses the window/position/dismiss scaffolding from
// AnimaytePet.swift; that native sprite pet stays untouched.
//
// Build:  swiftc -O dijon-pet.swift -o .build/dijon-pet
// Run:    ANIMAYTE_PORT=4321 .build/dijon-pet      (daemon must be running on that port)
// Env:    ANIMAYTE_PORT (default 4321)

import Cocoa
import WebKit

let env = ProcessInfo.processInfo.environment
let port = env["ANIMAYTE_PORT"] ?? "4321"

// ---------- a draggable, dismissable web view ----------
// The overlay page has no clickable UI (the speech bubble is pointer-events:none), so we
// claim mouseDown to drag the whole window, and right-click to dismiss — matching the feel
// of the native sprite pet.
final class PetWebView: WKWebView {
    override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
    override func rightMouseDown(with event: NSEvent) {
        let menu = NSMenu()
        let item = NSMenuItem(title: "Dismiss animayte",
                              action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        item.target = NSApp
        menu.addItem(item)
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }
}

// ---------- remembered position (~/.animayte/dijonpos.json) ----------
let posFile: URL = {
    let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".animayte")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("dijonpos.json")
}()
// A saved origin is only honored if the resulting window would land meaningfully on a
// visible screen. Without this, a value saved while the pet was dragged off-screen — or
// from a monitor layout that no longer exists — reopens the window completely invisible,
// with no in-app way to recover (you'd have to delete the JSON by hand). Require at least
// `minVisible` points of the window's width AND height to overlap some screen's visibleFrame.
func originIsOnScreen(_ origin: NSPoint) -> Bool {
    let minVisible: CGFloat = 40
    let rect = NSRect(x: origin.x, y: origin.y, width: winW, height: winH)
    for screen in NSScreen.screens {
        let hit = rect.intersection(screen.visibleFrame)
        if hit.width >= minVisible && hit.height >= minVisible { return true }
    }
    return false
}
func loadSavedOrigin() -> NSPoint? {
    guard let data = try? Data(contentsOf: posFile),
          let o = try? JSONSerialization.jsonObject(with: data) as? [String: Double],
          let x = o["x"], let y = o["y"] else { return nil }
    let origin = NSPoint(x: x, y: y)
    guard originIsOnScreen(origin) else { return nil }   // off-screen → fall back to defaultOrigin
    return origin
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
// Half-size pet: the window is halved AND the web content is rendered at pageZoom 0.5, so the
// grid runtime's fit() still sees a full-size logical viewport (winW/zoom × winH/zoom) and picks
// the same crisp integer cell — WebKit then downsamples the whole page 2:1 onto the small window.
let zoom: CGFloat = 0.5
let winW: CGFloat = 105, winH: CGFloat = 140   // headroom for the swollen head + props above
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

let webView = PetWebView(frame: NSRect(x: 0, y: 0, width: winW, height: winH),
                         configuration: WKWebViewConfiguration())
webView.setValue(false, forKey: "drawsBackground")   // transparent → the page's clear bg shows through
webView.wantsLayer = true
webView.layer?.backgroundColor = NSColor.clear.cgColor
webView.pageZoom = zoom   // render the whole page at 50% — see winW/winH note above
// "localhost" (not 127.0.0.1) so App Transport Security's localhost exception lets http load
if let url = URL(string: "http://localhost:\(port)/grid/pet.html") {
    webView.load(URLRequest(url: url))
}
panel.contentView = webView
panel.orderFrontRegardless()

// persist position whenever the user drags the pet
let moveObserver = NotificationCenter.default.addObserver(
    forName: NSWindow.didMoveNotification, object: panel, queue: .main) { _ in
    saveOrigin(panel.frame.origin)
}
_ = moveObserver

app.run()
