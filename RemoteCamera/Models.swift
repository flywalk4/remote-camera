import Foundation

/// A selectable lens (ultra wide, wide, telephoto).
struct LensInfo: Codable {
    let id: String
    let name: String
    /// Magnification relative to the main (wide) lens: 0.5, 1, 3, 5…
    let factor: Double
}

struct CaptureStatus: Codable {
    var busy = false
    var total = 0
    var done = 0
    var countdown = 0
    var lastError: String?
}

/// Full camera state that the remote fetches via GET /api/state.
struct CameraState: Codable {
    var running = false
    var error: String?

    var lenses: [LensInfo] = []
    var lens = ""
    var resolution = ""

    var zoom = 1.0
    var minZoom = 1.0
    var maxZoom = 1.0

    var exposureMode = "auto"   // auto | manual
    var iso = 0.0
    var minISO = 0.0
    var maxISO = 0.0
    var shutter = 0.0           // seconds
    var minShutter = 0.0
    var maxShutter = 0.0
    var bias = 0.0
    var minBias = 0.0
    var maxBias = 0.0
    /// Deviation from the "correct" exposure according to the meter (EV).
    var exposureOffset = 0.0

    var focusMode = "auto"      // auto | manual
    var lensPosition = 0.0      // 0 = near, 1 = far
    var manualFocusSupported = false

    var wbMode = "auto"         // auto | manual
    var temperature = 5000.0
    var tint = 0.0
    var manualWBSupported = false

    var loupe = 1.0
    var formats: [String] = []  // heif, jpeg, raw, proraw
    var capture = CaptureStatus()
    var photoCount = 0

    var battery = -1.0          // 0…1, -1 if unknown
    var charging = false
    var thermal = "nominal"
}

/// Settings change from the remote (POST /api/settings). All fields are optional.
struct SettingsUpdate: Decodable {
    struct Point: Decodable { let x: Double; let y: Double }

    var lens: String?
    var zoom: Double?
    var exposureMode: String?
    var iso: Double?
    var shutter: Double?
    var bias: Double?
    var focusMode: String?
    var lensPosition: Double?
    var wbMode: String?
    var temperature: Double?
    var tint: Double?
    var point: Point?
    var loupe: Double?
}

/// Capture request (POST /api/capture).
struct CaptureRequest: Decodable {
    var format = "heif"
    var count = 1
    var interval = 0.0
    var delay = 0.0
    var saveToPhotos = false

    enum CodingKeys: String, CodingKey { case format, count, interval, delay, saveToPhotos }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        format = try c.decodeIfPresent(String.self, forKey: .format) ?? "heif"
        count = max(1, min(try c.decodeIfPresent(Int.self, forKey: .count) ?? 1, 9999))
        interval = max(0, try c.decodeIfPresent(Double.self, forKey: .interval) ?? 0)
        delay = max(0, min(try c.decodeIfPresent(Double.self, forKey: .delay) ?? 0, 60))
        saveToPhotos = try c.decodeIfPresent(Bool.self, forKey: .saveToPhotos) ?? false
    }
}

func clamp<T: Comparable>(_ value: T, _ lower: T, _ upper: T) -> T {
    min(max(value, lower), upper)
}
