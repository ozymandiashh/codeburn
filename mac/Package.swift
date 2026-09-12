// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CodeBurnMenubar",
    platforms: [
        // macOS 14 (Sonoma) is the floor: matches Info.plist LSMinimumSystemVersion,
        // the CLI install guard (MIN_MACOS_MAJOR=14), and mac/README. The earlier .v15
        // bump for NSAttributedString(attachment:) was a misdiagnosis, that initializer
        // is AppKit since macOS 10.0, so the binary's minos must not exclude Sonoma users.
        .macOS(.v14)
    ],
    products: [
        .executable(name: "CodeBurnMenubar", targets: ["CodeBurnMenubar"])
    ],
    targets: [
        .executableTarget(
            name: "CodeBurnMenubar",
            path: "Sources/CodeBurnMenubar",
            resources: [
                .process("Resources/ProviderIcons"),
                // The Codex reset history the forecast reads. A byte-identical
                // copy of src/data/codex-reset-history.json, because SwiftPM
                // resources must live inside the target directory; the refresh
                // workflow writes both and a test pins them together. `.copy`
                // rather than `.process` so the JSON is never rewritten.
                .copy("Resources/CodexResetHistory")
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency")
            ],
            linkerSettings: [
                .linkedLibrary("sqlite3")
            ]
        ),
        .testTarget(
            name: "CodeBurnMenubarTests",
            dependencies: ["CodeBurnMenubar"],
            path: "Tests/CodeBurnMenubarTests",
            linkerSettings: [
                .linkedLibrary("sqlite3")
            ]
        )
    ]
)
