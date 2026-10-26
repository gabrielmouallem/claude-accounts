// The app each account can keep in the Dock. src/launchers.ts builds one bundle per account around this program, with
// the account's name, folders and icon in the bundle. The same program does the work those bundles need:
//
//   (opened as a launcher)                      opens the account's Claude Desktop, or brings it forward
//   --render-icon <file.icns> <label>           draws an account's icon
//   --dock-list                                 prints the launchers kept in the Dock
//   --dock-add <id> <app> <label>               keeps a launcher in the Dock, or points its tile at a moved bundle
//   --dock-remove <id>...                       takes launchers out of the Dock
//
// Dock edits touch only tiles whose bundle id starts with LAUNCHER_PREFIX, and the caller restarts the Dock after them.
// scripts/build-launcher.ts compiles this for Apple silicon and Intel, macOS 13 and later.
import AppKit

let CLAUDE_ID = "com.anthropic.claudefordesktop"
let LAUNCHER_PREFIX = "dev.gabriel.claude-accounts.launcher."

func warn(_ text: String) { FileHandle.standardError.write(Data("launcher: \(text)\n".utf8)) }
func usage() -> Int32 {
    warn("usage: --render-icon <file.icns> <label> | --dock-list | --dock-add <id> <app> <label> | --dock-remove <id>...")
    return 2
}
@discardableResult func run(_ exe: String, _ args: [String]) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    do { try p.run() } catch { return -1 }
    p.waitUntilExit()
    return p.terminationStatus
}

// ---------------------------------------------------------------- icon
// Claude Accounts' own look: the graphite ground of its app icon, with Claude's mark and the account's name below it,
// both in white. The name tells launchers apart; at 64 pixels and less it gives way to its initial, larger. The
// geometry is Apple's icon template: an 824-pixel rounded square, corners 186, centered on a 1024 canvas.

// Claude's mark, the Simple Icons path (CC0) the app's repository avatars use, in a 24-unit box with y pointing down.
let MARK = "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"

// Parses the SVG path commands the mark uses (M L H V C Z, absolute and relative) into a CGPath.
func parsePath(_ d: String) -> CGPath {
    let path = CGMutablePath()
    let re = try! NSRegularExpression(pattern: "[MmLlHhVvCcZz]|[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?")
    let tokens = re.matches(in: d, range: NSRange(d.startIndex..., in: d)).map { String(d[Range($0.range, in: d)!]) }
    var i = 0, cmd = "M", cur = CGPoint.zero, start = CGPoint.zero
    func num() -> CGFloat { defer { i += 1 }; return CGFloat(Double(tokens[i])!) }
    func pt(_ rel: Bool) -> CGPoint { let p = CGPoint(x: num(), y: num()); return rel ? CGPoint(x: cur.x + p.x, y: cur.y + p.y) : p }
    while i < tokens.count {
        if tokens[i].first!.isLetter { cmd = tokens[i]; i += 1 }
        let rel = cmd.first!.isLowercase
        switch cmd.uppercased() {
        case "M": cur = pt(rel); path.move(to: cur); start = cur; cmd = rel ? "l" : "L"   // more pairs after a move are lines
        case "L": cur = pt(rel); path.addLine(to: cur)
        case "H": let x = num(); cur.x = rel ? cur.x + x : x; path.addLine(to: cur)
        case "V": let y = num(); cur.y = rel ? cur.y + y : y; path.addLine(to: cur)
        case "C": let c1 = pt(rel), c2 = pt(rel), end = pt(rel); path.addCurve(to: end, control1: c1, control2: c2); cur = end
        case "Z": path.closeSubpath(); cur = start
        default: fatalError("unsupported path command \(cmd)")
        }
    }
    return path
}

func srgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat(hex >> 16 & 255) / 255, green: CGFloat(hex >> 8 & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: alpha)
}

func drawIcon(label: String, px: Int) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    let g = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = g
    let ctx = g.cgContext, s = CGFloat(px) / 1024
    ctx.scaleBy(x: s, y: s)
    let small = px <= 64                                        // too small for a word: the initial, larger
    let square = CGRect(x: 100, y: 100, width: 824, height: 824)
    let body = CGPath(roundedRect: square, cornerWidth: 186, cornerHeight: 186, transform: nil)
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    func gradient(_ stops: [(CGFloat, CGColor)]) -> CGGradient {
        CGGradient(colorsSpace: space, colors: stops.map { $0.1 } as CFArray, locations: stops.map { $0.0 })!
    }
    func vertical(_ grad: CGGradient, from top: CGFloat, to bottom: CGFloat) {   // y points up here
        ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: top), end: CGPoint(x: 0, y: bottom), options: [])
    }

    ctx.saveGState()                                            // shadow
    ctx.setShadow(offset: CGSize(width: 0, height: -18), blur: 44, color: srgb(0x000000, 0.36))
    ctx.addPath(body); ctx.setFillColor(srgb(0x09090b)); ctx.fillPath()
    ctx.restoreGState()

    // ground and sheen, as in scripts/icon-art.ts. The sheen fades along a smoothstep curve: a straight fade shows as
    // bands on a dark ground.
    ctx.saveGState()
    ctx.addPath(body); ctx.clip()
    vertical(gradient([(0, srgb(0x2b2b30)), (1, srgb(0x09090b))]), from: 924, to: 100)
    let fade = (0...8).map { i -> (CGFloat, CGColor) in let t = CGFloat(i) / 8; return (t, srgb(0xffffff, 0.1 * (1 - t * t * (3 - 2 * t)))) }
    ctx.drawRadialGradient(gradient(fade), startCenter: CGPoint(x: 512, y: 924), startRadius: 0, endCenter: CGPoint(x: 512, y: 924), endRadius: 640, options: [])
    ctx.restoreGState()

    // the mark above the name, shaded like the app icon's white ring
    let markSize: CGFloat = small ? 360 : 400, cy: CGFloat = small ? 637 : 600
    var t = CGAffineTransform(translationX: 512 - markSize / 2, y: cy + markSize / 2).scaledBy(x: markSize / 24, y: -markSize / 24)
    if let mark = parsePath(MARK).copy(using: &t) {
        ctx.saveGState(); ctx.addPath(mark); ctx.clip()
        vertical(gradient([(0, srgb(0xffffff)), (0.55, srgb(0xececef)), (1, srgb(0xb9b9c1))]), from: cy + markSize / 2, to: cy - markSize / 2)
        ctx.restoreGState()
    }

    // the name, shrunk until it fits
    let text = small ? String(label.prefix(1)) : label
    let maxWidth: CGFloat = 824 - 2 * 80, cap: CGFloat = small ? 200 : 100, baseline: CGFloat = small ? 207 : 228
    func font(_ size: CGFloat) -> NSFont {
        let f = NSFont.systemFont(ofSize: size, weight: .heavy)
        return f.fontDescriptor.withDesign(.rounded).flatMap { NSFont(descriptor: $0, size: size) } ?? f
    }
    func styled(_ size: CGFloat) -> NSAttributedString {
        NSAttributedString(string: text, attributes: [.font: font(size), .foregroundColor: NSColor(cgColor: srgb(0xececef))!, .kern: size * 0.04])
    }
    var size = cap / font(100).capHeight * 100
    while styled(size).size().width > maxWidth && size > 20 { size *= 0.96 }
    let line = styled(size)
    line.draw(at: CGPoint(x: 512 - line.size().width / 2, y: baseline + font(size).descender))

    // the rim keeps a dark icon apart from a dark Dock
    ctx.saveGState()
    ctx.addPath(CGPath(roundedRect: square.insetBy(dx: 1.5, dy: 1.5), cornerWidth: 184.5, cornerHeight: 184.5, transform: nil))
    ctx.setLineWidth(3); ctx.replacePathWithStrokedPath(); ctx.clip()
    vertical(gradient([(0, srgb(0xffffff, 0.22)), (0.4, srgb(0xffffff, 0.03)), (1, srgb(0xffffff, 0.06))]), from: 924, to: 100)
    ctx.restoreGState()
    return rep.retagging(with: .sRGB) ?? rep
}

// The sizes in an .icns, each a PNG: 16 and 32 points at 2x, and 128, 256 and 512 points at 1x and 2x. iconutil stores
// 16 and 32 at 1x as raw ARGB (ic04, ic05); as PNGs (icp4, icp5) current macOS decodes them as noise, so they're left
// out and macOS scales the 2x ones down.
let ICNS: [(String, Int)] = [("ic11", 32), ("ic12", 64), ("ic07", 128), ("ic13", 256), ("ic08", 256), ("ic14", 512),
                             ("ic09", 512), ("ic10", 1024)]

func renderIcon(_ args: [String]) -> Int32 {
    guard args.count == 3, !args[2].isEmpty else { return usage() }
    func be32(_ n: Int) -> Data { withUnsafeBytes(of: UInt32(n).bigEndian) { Data($0) } }
    var pngs: [Int: Data] = [:], body = Data()
    for (type, px) in ICNS {
        if pngs[px] == nil { pngs[px] = drawIcon(label: args[2], px: px).representation(using: .png, properties: [:]) }
        guard let png = pngs[px] else { warn("couldn't draw the icon"); return 1 }
        body += Data(type.utf8) + be32(png.count + 8) + png
    }
    do { try (Data("icns".utf8) + be32(body.count + 8) + body).write(to: URL(fileURLWithPath: args[1]), options: .atomic) }
    catch { warn("couldn't write \(args[1]): \(error.localizedDescription)"); return 1 }
    return 0
}

// ---------------------------------------------------------------- Dock
// The Dock keeps its apps in com.apple.dock's persistent-apps, read and written here through cfprefsd. The Dock reads
// them again when it restarts. Tiles that aren't launchers pass through untouched.
let DOCK = "com.apple.dock" as CFString, KEPT = "persistent-apps" as CFString
typealias Tile = [String: Any]

// nil when the list can't be read: writing then would replace the whole Dock
func keptTiles() -> [Tile]? {
    CFPreferencesAppSynchronize(DOCK)
    return CFPreferencesCopyAppValue(KEPT, DOCK) as? [Tile]
}
// false when a profile (MDM) sets the list: it isn't the user's, and writing it back would replace their own
func saveTiles(_ tiles: [Tile]) -> Bool {
    if CFPreferencesAppValueIsForced(KEPT, DOCK) { return false }
    CFPreferencesSetAppValue(KEPT, tiles as CFArray, DOCK)
    return CFPreferencesAppSynchronize(DOCK)
}
func tileData(_ t: Tile) -> [String: Any] { t["tile-data"] as? [String: Any] ?? [:] }
func tileID(_ t: Tile) -> String? { tileData(t)["bundle-identifier"] as? String }
func tileURL(_ t: Tile) -> String? { (tileData(t)["file-data"] as? [String: Any])?["_CFURLString"] as? String }
func restartDock() { run("/usr/bin/killall", ["Dock"]) }

func dockCommand(_ args: [String]) -> Int32 {
    guard let tiles = keptTiles() else { warn("couldn't read the Dock's apps, so nothing changed"); return 1 }
    var next = tiles
    switch (args[0], args.count) {
    case ("--dock-list", 1):
        for id in tiles.compactMap(tileID) where id.hasPrefix(LAUNCHER_PREFIX) { print(id) }
        return 0
    case ("--dock-add", 4) where args[1].hasPrefix(LAUNCHER_PREFIX):
        let id = args[1], url = URL(fileURLWithPath: args[2], isDirectory: true).absoluteString, label = args[3]
        if let i = next.firstIndex(where: { tileID($0) == id }) {
            // kept already: point it at the bundle, which moves when the account is renamed, and keep its place
            if tileURL(next[i]) == url && tileData(next[i])["file-label"] as? String == label { print("unchanged"); return 0 }
            var data = tileData(next[i])
            data["file-data"] = ["_CFURLString": url, "_CFURLStringType": 15]
            data["file-label"] = label
            data.removeValue(forKey: "book")                   // a bookmark to where the bundle was
            next[i]["tile-data"] = data
        } else {
            next.append(["GUID": Int.random(in: 1..<Int(Int32.max)), "tile-type": "file-tile", "tile-data": [
                "bundle-identifier": id, "file-label": label, "file-type": 41, "dock-extra": false, "is-beta": false,
                "file-data": ["_CFURLString": url, "_CFURLStringType": 15]] as [String: Any]])
        }
    case ("--dock-remove", 2...) where args.dropFirst().allSatisfy({ $0.hasPrefix(LAUNCHER_PREFIX) }):
        let ids = Set(args.dropFirst())
        next = tiles.filter { tileID($0).map { !ids.contains($0) } ?? true }
        if next.count == tiles.count { print("unchanged"); return 0 }
    default:
        return usage()
    }
    guard saveTiles(next) else {
        warn(CFPreferencesAppValueIsForced(KEPT, DOCK) ? "your organization manages the Dock's apps, so nothing changed" : "couldn't save the Dock's apps")
        return 1
    }
    print("changed")
    return 0
}

// ---------------------------------------------------------------- the launcher
// Opened from the Dock, Spotlight or Claude Accounts, it looks for the account's Claude Desktop by the folder on its
// command line. An open one comes forward; otherwise it opens. The launcher then stays open while that Claude runs,
// so its Dock icon shows it running, and quits with it. Quitting the launcher quits that Claude.

// A process's arguments, from the kernel. KERN_PROCARGS2 holds the environment after them; this reads the arguments
// only, and wipes the buffer.
func arguments(of pid: pid_t) -> [String] {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid], size = 0
    guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 4 else { return [] }
    var buf = [UInt8](repeating: 0, count: size)
    defer { _ = buf.withUnsafeMutableBytes { memset_s($0.baseAddress, $0.count, 0, $0.count) } }
    guard sysctl(&mib, 3, &buf, &size, nil, 0) == 0, size > 4 else { return [] }
    let argc = buf.withUnsafeBytes { Int($0.loadUnaligned(as: Int32.self)) }
    var i = 4, out: [String] = []
    while i < size && buf[i] != 0 { i += 1 }                   // the executable's path
    while i < size && buf[i] == 0 { i += 1 }                   // and its padding
    while out.count < argc && i < size {
        var j = i
        while j < size && buf[j] != 0 { j += 1 }
        out.append(String(decoding: buf[i..<j], as: UTF8.self))
        i = j + 1
    }
    return out
}
func userDataDir(of pid: pid_t) -> String? {
    let args = arguments(of: pid)
    for (i, a) in args.enumerated() {
        if a.hasPrefix("--user-data-dir=") { return String(a.dropFirst("--user-data-dir=".count)) }
        if a == "--user-data-dir", i + 1 < args.count { return args[i + 1] }
    }
    return nil
}
// Folder names ignore case on macOS, and a temp folder is a symlink into /private.
func samePath(_ a: String, _ b: String) -> Bool {
    func canonical(_ p: String) -> String {
        URL(fileURLWithPath: (p as NSString).expandingTildeInPath).standardizedFileURL.resolvingSymlinksInPath().path.lowercased()
    }
    return !a.isEmpty && !b.isEmpty && canonical(a) == canonical(b)
}
// Whether a process has a normal window on screen. The window list gives owners and sizes without any permission; only
// titles and contents need Screen Recording, and this reads neither.
func hasWindowOnScreen(_ pid: pid_t) -> Bool {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return list.contains { w in
        guard (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid, (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b) else { return false }
        return r.width > 100 && r.height > 100
    }
}

final class Launcher: NSObject, NSApplicationDelegate {
    let info = Bundle.main.infoDictionary ?? [:]
    let noGuide: Bool, attachOnly: Bool
    var account: String, desktopDir: String, configDir: String
    var claude: NSRunningApplication?
    var exitWatch: DispatchSourceProcess?, quietExit: DispatchSourceSignal?
    var launching = false, quitting = false, alerting = false
    var lastFocus = Date.distantPast, launchedAt = Date.distantPast

    init(flags: Set<String>) {
        noGuide = flags.contains("--no-guide")      // Claude Accounts showed its own sign-in guide
        attachOnly = flags.contains("--attach")     // the app rebuilt this launcher while its Claude was open
        account = info["CAAccount"] as? String ?? "this account"
        desktopDir = info["CAUserDataDir"] as? String ?? ""
        configDir = info["CAConfigDir"] as? String ?? ""
    }
    var name: String { info["CFBundleName"] as? String ?? "This launcher" }

    func applicationDidFinishLaunching(_ note: Notification) {
        // This program's environment reaches Claude, where these would override the account's sign-in (claudeEnv in
        // src/core.ts). A variable set for every app with launchctl setenv can still reach it.
        let drop = ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"]
        for key in ProcessInfo.processInfo.environment.keys where drop.contains(key.uppercased()) {
            unsetenv(key)
        }
        // Claude Accounts sends SIGUSR1 when it replaces or removes this launcher: leave, and leave Claude open.
        signal(SIGUSR1, SIG_IGN)
        let s = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        s.setEventHandler { exit(0) }
        s.resume(); quietExit = s
        NSApp.mainMenu = mainMenu()
        guard !desktopDir.isEmpty, accountStillThere() else { NSApp.terminate(nil); return }
        if let open = findClaude() {
            attach(open)
            if !attachOnly { focus(open) }
        } else if attachOnly {
            NSApp.terminate(nil)
        } else {
            openClaude()
        }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if let c = claude { focus(c) } else if !launching && !alerting { openClaude() }
        return false
    }
    // Switching to the launcher, with Command-Tab say, switches to its Claude.
    func applicationDidBecomeActive(_ note: Notification) {
        if let c = claude, !alerting { focus(c) }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let c = claude, !c.isTerminated else { return .terminateNow }
        quitting = true
        kill(c.processIdentifier, SIGTERM)          // Claude quits the way it does from its own menu
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            if self?.claude != nil { NSApp.reply(toApplicationShouldTerminate: true) }   // it didn't: leave it open
        }
        return .terminateLater
    }
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    func mainMenu() -> NSMenu {
        let menu = NSMenu(), item = NSMenuItem(), sub = NSMenu()
        sub.addItem(withTitle: "Quit \(name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = sub; menu.addItem(item)
        return menu
    }

    // config.json is the truth: an account can be renamed or removed with ca while Claude Accounts is closed. When it
    // can't be read, the bundle's own values stand.
    func accountStillThere() -> Bool {
        guard let path = info["CAConfigPath"] as? String, let data = FileManager.default.contents(atPath: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let accounts = json["accounts"] as? [String: Any] else { return true }
        for (n, value) in accounts {
            guard let a = value as? [String: Any], let d = a["desktop_user_data_dir"] as? String, samePath(d, desktopDir) else { continue }
            account = n
            if let c = a["config_dir"] as? String, !c.isEmpty { configDir = c }
            return true
        }
        let removeIt = ask("\(account) isn't in Claude Accounts anymore",
                           "This launcher opened that account's Claude Desktop. You can take it out of the Dock.",
                           ["Remove from Dock", "Cancel"]) == .alertFirstButtonReturn
        if removeIt {
            if let id = Bundle.main.bundleIdentifier, let tiles = keptTiles() {
                let next = tiles.filter { tileID($0) != id }
                if next.count != tiles.count && saveTiles(next) { restartDock() }
            }
            try? FileManager.default.trashItem(at: Bundle.main.bundleURL, resultingItemURL: nil)
        }
        return false
    }

    func findClaude() -> NSRunningApplication? {
        NSWorkspace.shared.runningApplications.first {
            $0.bundleIdentifier == CLAUDE_ID && !$0.isTerminated && userDataDir(of: $0.processIdentifier).map { samePath($0, desktopDir) } == true
        }
    }

    func openClaude() {
        let empty = (try? FileManager.default.contentsOfDirectory(atPath: desktopDir))?.isEmpty ?? true
        if empty && !noGuide && !signInGuide() { if claude == nil { NSApp.terminate(nil) }; return }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: CLAUDE_ID) else {
            return stop("Claude Desktop isn't installed", "Install it from claude.ai/download, then open \(name) again.")
        }
        for d in [desktopDir, configDir] where !d.isEmpty {     // private, like every account folder
            try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        let c = NSWorkspace.OpenConfiguration()
        c.createsNewApplicationInstance = true      // other accounts' Claude may be open
        c.arguments = ["--user-data-dir=\(desktopDir)"]
        c.environment = ["CLAUDE_CONFIG_DIR": configDir]
        c.addsToRecentItems = false
        launching = true
        launchedAt = Date()
        NSWorkspace.shared.openApplication(at: url, configuration: c) { app, error in
            DispatchQueue.main.async {
                self.launching = false
                if let app { self.attach(app) } else { self.stop("Claude Desktop didn't open", error?.localizedDescription ?? "") }
            }
        }
    }

    func attach(_ app: NSRunningApplication) {
        claude = app
        let s = DispatchSource.makeProcessSource(identifier: app.processIdentifier, eventMask: .exit, queue: .main)
        s.setEventHandler { [weak self] in self?.claudeExited() }
        s.resume(); exitWatch = s
        if app.isTerminated { claudeExited() }
    }
    func claudeExited() {
        guard claude != nil else { return }
        exitWatch?.cancel(); exitWatch = nil; claude = nil
        if quitting { NSApp.reply(toApplicationShouldTerminate: true) } else { NSApp.terminate(nil) }
    }

    func focus(_ app: NSRunningApplication) {
        guard Date().timeIntervalSince(lastFocus) > 0.5 else { return }   // a Dock click both activates and reopens
        lastFocus = Date()
        if app.isHidden { app.unhide() }
        if #available(macOS 14, *) {
            NSApp.yieldActivation(to: app)
            app.activate(from: .current, options: [.activateAllWindows])
        } else {
            app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
        }
        // Claude keeps running after its last window closes. A click on Claude in the Dock sends it a reopen event,
        // which brings its window back, and so does this. That event needs your consent, which macOS asks for once,
        // so it goes only when Claude still has no window on screen after coming forward. A window on another Space
        // comes into view by then.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            guard let self, self.claude == app, !app.isTerminated, Date().timeIntervalSince(self.launchedAt) > 10,   // still starting
                  !hasWindowOnScreen(app.processIdentifier) else { return }
            self.reopen(app)
        }
    }
    func reopen(_ app: NSRunningApplication) {
        let pid = app.processIdentifier
        DispatchQueue.global(qos: .userInitiated).async {
            let target = NSAppleEventDescriptor(processIdentifier: pid)
            let allowed = AEDeterminePermissionToAutomateTarget(target.aeDesc, AEEventClass(kCoreEventClass), AEEventID(kAEReopenApplication), true)
            DispatchQueue.main.async {
                if allowed == noErr {
                    let event = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEReopenApplication),
                                                       targetDescriptor: target, returnID: AEReturnID(kAutoGenerateReturnID),
                                                       transactionID: AETransactionID(kAnyTransactionID))
                    _ = try? event.sendEvent(options: [.noReply], timeout: 5)
                } else if allowed == OSStatus(errAEEventNotPermitted) {
                    self.windowless()
                }
            }
        }
    }

    // The same advice as the app's guide (desktopGuide in src/renderer/app.ts): a sign-in that finishes in the browser
    // goes back to the Claude that opened first, so the code from the email is the way in.
    func signInGuide() -> Bool {
        ask("Sign in to Claude for \(account)",
            """
            This account has its own Claude Desktop window. Sign in to it once, and it stays signed in.

            Choose Continue with email, then type the code from the email into that window. Don't click the link in the email.

            A sign-in that finishes in your browser, like Continue with Google, goes back to the Claude that was open first. To sign in with Google, quit your other Claude windows first.
            """, ["Open Claude", "Cancel"]) == .alertFirstButtonReturn
    }
    func windowless() {
        let settings = ask("Claude for \(account) is open without a window",
                           "To bring its window back from here, allow \(name) to control Claude in System Settings, under Privacy & Security, then Automation. Or quit it from this icon's menu in the Dock and open it again.",
                           ["Open System Settings", "Cancel"]) == .alertFirstButtonReturn
        if settings, let u = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation") { NSWorkspace.shared.open(u) }
    }
    func stop(_ title: String, _ text: String) {
        _ = ask(title, text, ["OK"])
        if claude == nil { NSApp.terminate(nil) }
    }
    func ask(_ title: String, _ text: String, _ buttons: [String]) -> NSApplication.ModalResponse {
        alerting = true
        defer { alerting = false }
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        for b in buttons { a.addButton(withTitle: b) }
        NSApp.activate(ignoringOtherApps: true)
        return a.runModal()
    }
}

// ---------------------------------------------------------------- main
let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "--render-icon": exit(renderIcon(args))
case "--dock-list", "--dock-add", "--dock-remove": exit(dockCommand(args))
default:
    guard Bundle.main.bundleIdentifier?.hasPrefix(LAUNCHER_PREFIX) == true else { exit(usage()) }
    let launcher = Launcher(flags: Set(args))
    NSApplication.shared.delegate = launcher
    NSApplication.shared.setActivationPolicy(.regular)
    NSApplication.shared.run()
}
