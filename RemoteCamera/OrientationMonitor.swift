import AVFoundation
import CoreMotion
import ImageIO

/// Physical orientation of the phone, measured with the accelerometer.
///
/// The app's interface is locked to portrait and the system rotation lock may be on,
/// so `UIDevice.orientation` can't be trusted — gravity always tells the truth.
/// The camera sensor delivers landscape frames; this is used to rotate the Mac preview
/// and to tag photos with the right orientation.
final class OrientationMonitor: @unchecked Sendable {
    enum Orientation: String {
        case portrait, portraitUpsideDown
        /// Home button / USB port on the right.
        case landscapeLeft
        /// Home button / USB port on the left.
        case landscapeRight
    }

    private let motion = CMMotionManager()
    private let queue = OperationQueue()
    private let lock = NSLock()
    private var _current = Orientation.portrait

    var current: Orientation {
        lock.lock(); defer { lock.unlock() }
        return _current
    }

    func start() {
        guard motion.isAccelerometerAvailable else { return }
        queue.maxConcurrentOperationCount = 1
        motion.accelerometerUpdateInterval = 0.2
        motion.startAccelerometerUpdates(to: queue) { [weak self] data, _ in
            guard let self, let g = data?.acceleration else { return }
            if let orientation = Self.orientation(x: g.x, y: g.y) {
                self.lock.lock()
                self._current = orientation
                self.lock.unlock()
            }
        }
    }

    /// Orientation from the gravity vector, or nil when the phone lies (almost) flat —
    /// e.g. pointing straight up at the sky — and the orientation is ambiguous.
    /// Then the last known orientation is kept.
    static func orientation(x: Double, y: Double) -> Orientation? {
        guard max(abs(x), abs(y)) > 0.35 else { return nil }
        if abs(y) >= abs(x) {
            return y < 0 ? .portrait : .portraitUpsideDown
        }
        return x < 0 ? .landscapeLeft : .landscapeRight
    }

    // MARK: - Mapping for the back camera (the sensor is natively landscape, home button on the right)

    /// How to rotate a sensor frame so it appears upright.
    static func imageOrientation(for o: Orientation) -> CGImagePropertyOrientation {
        switch o {
        case .portrait: return .right
        case .portraitUpsideDown: return .left
        case .landscapeLeft: return .up
        case .landscapeRight: return .down
        }
    }

    /// Rotation angle for `AVCaptureConnection.videoRotationAngle` (iOS 17+).
    static func rotationAngle(for o: Orientation) -> CGFloat {
        switch o {
        case .portrait: return 90
        case .portraitUpsideDown: return 270
        case .landscapeLeft: return 0
        case .landscapeRight: return 180
        }
    }

    /// Orientation for `AVCaptureConnection.videoOrientation` (iOS 15–16).
    static func videoOrientation(for o: Orientation) -> AVCaptureVideoOrientation {
        switch o {
        case .portrait: return .portrait
        case .portraitUpsideDown: return .portraitUpsideDown
        // AVCaptureVideoOrientation is named after the home button, UIDevice after the top.
        case .landscapeLeft: return .landscapeRight
        case .landscapeRight: return .landscapeLeft
        }
    }

    /// Converts a point clicked on the upright (rotated) preview into sensor coordinates,
    /// which is what focus/exposure points of interest use. Both are normalized 0…1.
    static func sensorPoint(x: Double, y: Double, for o: Orientation) -> (x: Double, y: Double) {
        switch o {
        case .landscapeLeft: return (x, y)
        case .landscapeRight: return (1 - x, 1 - y)
        case .portrait: return (y, 1 - x)
        case .portraitUpsideDown: return (1 - y, x)
        }
    }
}
