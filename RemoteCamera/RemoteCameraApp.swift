import AVFoundation
import SwiftUI
import UIKit

@main
struct RemoteCameraApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
        }
    }
}

final class AppModel: ObservableObject {
    static let port: UInt16 = 8080

    let store: PhotoStore
    let camera: CameraController
    private var server: HTTPServer?

    @Published var addresses: [String] = []
    @Published var serverError: String?
    @Published var dimmed = false {
        didSet { applyBrightness() }
    }
    private var savedBrightness: CGFloat = 0.5
    private var timer: Timer?

    init() {
        let store = PhotoStore()
        let frames = FrameBroadcaster()
        let camera = CameraController(store: store, frames: frames)
        self.store = store
        self.camera = camera
        let api = WebAPI(camera: camera, store: store)
        let server = HTTPServer(frames: frames) { api.handle($0) }
        do {
            try server.start(port: Self.port)
        } catch {
            serverError = "Сервер не запустился: \(error.localizedDescription)"
        }
        self.server = server
        camera.start()

        UIDevice.current.isBatteryMonitoringEnabled = true
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
    }

    var urls: [String] {
        addresses.map { "http://\($0):\(Self.port)" }
    }

    private func refresh() {
        let current = NetworkInfo.addresses()
        if current != addresses { addresses = current }
        let device = UIDevice.current
        camera.updateBattery(
            level: device.batteryLevel < 0 ? -1 : Double(device.batteryLevel),
            charging: device.batteryState == .charging || device.batteryState == .full
        )
    }

    /// «Ночной режим» экрана: чёрный экран и минимальная яркость —
    /// не засвечивает глаза и кадр, экономит батарею.
    private func applyBrightness() {
        if dimmed {
            savedBrightness = UIScreen.main.brightness
            UIScreen.main.brightness = 0
        } else {
            UIScreen.main.brightness = savedBrightness
        }
    }

    func quickCapture() {
        _ = camera.capture(CaptureRequest())
    }
}
