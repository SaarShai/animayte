// swift-tools-version:5.7
// animayte native Rive pet — hosts a .riv in the floating macOS window via the
// official Rive Apple runtime (MIT). Build: `cd desktop/rive && swift build -c release`.
// Run with the daemon up (it serves the .riv): the app loads
// http://127.0.0.1:<port>/pets/<pet>/pet.riv and drives the contract inputs from /health.
import PackageDescription

let package = Package(
    name: "AnimaytePetRive",
    platforms: [.macOS(.v13)],            // rive-ios supports macOS ≥13.1 (AppKit + SwiftUI)
    dependencies: [
        // verify the latest at https://github.com/rive-app/rive-ios/releases and bump as needed
        .package(url: "https://github.com/rive-app/rive-ios", from: "6.0.0"),
    ],
    targets: [
        .executableTarget(
            name: "AnimaytePetRive",
            dependencies: [.product(name: "RiveRuntime", package: "rive-ios")]
        ),
    ]
)
