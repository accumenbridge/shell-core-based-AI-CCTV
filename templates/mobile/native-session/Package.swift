// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "QuadbridgeNativeSession",
    platforms: [.iOS(.v15)],
    products: [.library(name: "QuadbridgeNativeSession", targets: ["NativeSessionPlugin"])],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.2")
    ],
    targets: [
        .target(
            name: "NativeSessionPlugin",
            dependencies: [.product(name: "Capacitor", package: "capacitor-swift-pm")],
            path: "ios/Sources/NativeSessionPlugin"
        )
    ]
)
