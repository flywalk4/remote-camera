import AVFoundation
import CoreImage
import ImageIO
import Photos
import UIKit

/// Camera control: lens selection and every manual setting (ISO, shutter speed,
/// focus, white balance, zoom), photo/RAW and series capture, preview for the remote.
///
/// All AVCaptureSession work happens on `sessionQueue`.
final class CameraController: NSObject, @unchecked Sendable {
    let session = AVCaptureSession()
    let frames: FrameBroadcaster
    let store: PhotoStore

    private let sessionQueue = DispatchQueue(label: "camera.session")
    private let videoQueue = DispatchQueue(label: "camera.video")
    private let seriesQueue = DispatchQueue(label: "camera.series")

    private let photoOutput = AVCapturePhotoOutput()
    private let videoOutput = AVCaptureVideoDataOutput()
    private var input: AVCaptureDeviceInput?
    private var device: AVCaptureDevice? { input?.device }
    private var lenses: [AVCaptureDevice] = []
    private var lensInfo: [LensInfo] = []
    private var setupError: String?

    // Settings chosen by the user. Kept separately from the device so they can be
    // re-applied after a lens switch (each lens has its own ISO/shutter ranges).
    private struct Desired {
        var manualExposure = false
        var iso = 100.0
        var shutter = 1.0 / 250
        var bias = 0.0
        var manualFocus = false
        var lensPosition = 1.0
        var manualWB = false
        var temperature = 5000.0
        var tint = 0.0
        var zoom = 1.0
    }
    private var desired = Desired()

    // Preview
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private let lock = NSLock()
    private var _loupe = 1.0
    private var lastFrameTime: CFTimeInterval = 0

    // Capture
    private var captureStatus = CaptureStatus()
    private var cancelRequested = false
    private var processors: [Int64: PhotoProcessor] = [:]
    /// Settings of the last capture from the remote — reused by the shutter button on the iPhone.
    private var lastRequest = CaptureRequest()

    // Watches the device for AVFoundation silently dropping manual modes.
    private var observations: [NSKeyValueObservation] = []

    // Battery (updated from the main thread — UIDevice must not be read in the background)
    private var battery = (level: -1.0, charging: false)

    init(store: PhotoStore, frames: FrameBroadcaster) {
        self.store = store
        self.frames = frames
        super.init()
    }

    private var loupe: Double {
        get { lock.lock(); defer { lock.unlock() }; return _loupe }
        set { lock.lock(); _loupe = newValue; lock.unlock() }
    }

    func updateBattery(level: Double, charging: Bool) {
        lock.lock()
        battery = (level, charging)
        lock.unlock()
    }

    // MARK: - Startup

    func start() {
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            guard let self else { return }
            self.sessionQueue.async {
                guard granted else {
                    self.setupError = "No camera access. Allow it in Settings → Remote Camera."
                    return
                }
                self.configureSession()
                self.session.startRunning()
            }
        }
    }

    private func configureSession() {
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInUltraWideCamera, .builtInWideAngleCamera, .builtInTelephotoCamera],
            mediaType: .video,
            position: .back
        )
        lenses = discovery.devices
        guard let wide = lenses.first(where: { $0.deviceType == .builtInWideAngleCamera }) ?? lenses.first else {
            setupError = "Back camera not found"
            return
        }

        // Lens magnification is computed from the field of view relative to the main lens.
        let wideFov = Double(wide.activeFormat.videoFieldOfView)
        lensInfo = lenses.map { dev in
            let fov = Double(dev.activeFormat.videoFieldOfView)
            let factor = tan(wideFov * .pi / 360) / tan(fov * .pi / 360)
            let rounded = (factor * 10).rounded() / 10
            let name: String
            switch dev.deviceType {
            case .builtInUltraWideCamera: name = "Ultra Wide"
            case .builtInTelephotoCamera: name = "Telephoto"
            default: name = "Wide"
            }
            return LensInfo(id: dev.uniqueID, name: name, factor: rounded)
        }

        session.beginConfiguration()
        session.sessionPreset = .photo
        do {
            let newInput = try AVCaptureDeviceInput(device: wide)
            if session.canAddInput(newInput) {
                session.addInput(newInput)
                input = newInput
            }
        } catch {
            setupError = "Could not open the camera: \(error.localizedDescription)"
        }
        if session.canAddOutput(photoOutput) {
            session.addOutput(photoOutput)
        }
        videoOutput.alwaysDiscardsLateVideoFrames = true
        videoOutput.setSampleBufferDelegate(self, queue: videoQueue)
        if session.canAddOutput(videoOutput) {
            session.addOutput(videoOutput)
        }
        session.commitConfiguration()
        configurePhotoOutput()
        observeDevice()
    }

    private func configurePhotoOutput() {
        guard let device else { return }
        photoOutput.maxPhotoQualityPrioritization = .quality
        if photoOutput.isAppleProRAWSupported {
            photoOutput.isAppleProRAWEnabled = true
        }
        let sizes = device.activeFormat.supportedMaxPhotoDimensions
        if let largest = sizes.max(by: { Int($0.width) * Int($0.height) < Int($1.width) * Int($1.height) }) {
            photoOutput.maxPhotoDimensions = largest
        }
    }

    private func switchLens(to id: String) {
        guard let newDevice = lenses.first(where: { $0.uniqueID == id }), newDevice != device else { return }
        session.beginConfiguration()
        let oldInput = input
        if let oldInput { session.removeInput(oldInput) }
        if let newInput = try? AVCaptureDeviceInput(device: newDevice), session.canAddInput(newInput) {
            session.addInput(newInput)
            input = newInput
        } else if let oldInput, session.canAddInput(oldInput) {
            session.addInput(oldInput)
        }
        session.commitConfiguration()
        configurePhotoOutput()
        observeDevice()
        desired.zoom = 1
        applyAll()
    }

    /// iOS can reset the camera to auto exposure / autofocus on its own — most notably
    /// around a full-resolution (48 MP) capture, when the sensor switches readout mode.
    /// Whenever the device leaves a manual mode the user chose, put it back.
    private func observeDevice() {
        observations = []
        guard let device else { return }
        let onChange: () -> Void = { [weak self] in
            self?.sessionQueue.async { self?.enforceDesired() }
        }
        observations = [
            device.observe(\.exposureMode, options: [.new]) { _, _ in onChange() },
            device.observe(\.focusMode, options: [.new]) { _, _ in onChange() },
            device.observe(\.whiteBalanceMode, options: [.new]) { _, _ in onChange() },
        ]
    }

    /// Re-applies the user's settings if the device drifted away from a manual mode.
    private func enforceDesired() {
        guard let device else { return }
        let drifted = (desired.manualExposure && device.exposureMode != .custom)
            || (desired.manualFocus && device.focusMode != .locked)
            || (desired.manualWB && device.whiteBalanceMode != .locked)
        if drifted { applyAll() }
    }

    private var hasManualSettings: Bool {
        desired.manualExposure || desired.manualFocus || desired.manualWB
    }

    // MARK: - Settings

    func apply(_ update: SettingsUpdate) {
        sessionQueue.async { [self] in
            if let loupe = update.loupe { self.loupe = clamp(loupe, 1, 16) }
            if let lens = update.lens { switchLens(to: lens) }
            guard let device else { return }

            // Switching to manual without explicit values freezes the current ones.
            let toManualExposure = update.exposureMode == "manual" || update.iso != nil || update.shutter != nil
            if toManualExposure && !desired.manualExposure {
                desired.iso = Double(device.iso)
                desired.shutter = device.exposureDuration.seconds
            }
            if let mode = update.exposureMode { desired.manualExposure = mode == "manual" }
            if let iso = update.iso { desired.iso = iso; desired.manualExposure = true }
            if let shutter = update.shutter { desired.shutter = shutter; desired.manualExposure = true }
            if let bias = update.bias { desired.bias = bias }

            if update.focusMode == "manual" && !desired.manualFocus {
                desired.lensPosition = Double(device.lensPosition)
            }
            if let mode = update.focusMode { desired.manualFocus = mode == "manual" }
            if let pos = update.lensPosition { desired.lensPosition = pos; desired.manualFocus = true }

            let toManualWB = update.wbMode == "manual" || update.temperature != nil || update.tint != nil
            if toManualWB && !desired.manualWB {
                let current = device.temperatureAndTintValues(for: device.deviceWhiteBalanceGains)
                desired.temperature = Double(current.temperature)
                desired.tint = Double(current.tint)
            }
            if let mode = update.wbMode { desired.manualWB = mode == "manual" }
            if let t = update.temperature { desired.temperature = t; desired.manualWB = true }
            if let t = update.tint { desired.tint = t; desired.manualWB = true }

            if let zoom = update.zoom { desired.zoom = zoom }

            applyAll()

            if let p = update.point { setPointOfInterest(CGPoint(x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1))) }
        }
    }

    /// Applies `desired` to the current device (clamped to its ranges).
    private func applyAll() {
        guard let device else { return }
        do { try device.lockForConfiguration() } catch { return }
        defer { device.unlockForConfiguration() }

        let zoomLimit = min(device.maxAvailableVideoZoomFactor, 20)
        device.videoZoomFactor = CGFloat(clamp(desired.zoom, Double(device.minAvailableVideoZoomFactor), Double(zoomLimit)))

        let format = device.activeFormat
        if desired.manualExposure, device.isExposureModeSupported(.custom) {
            let iso = Float(clamp(desired.iso, Double(format.minISO), Double(format.maxISO)))
            let seconds = clamp(desired.shutter, format.minExposureDuration.seconds, format.maxExposureDuration.seconds)
            device.setExposureModeCustom(
                duration: CMTime(seconds: seconds, preferredTimescale: 1_000_000_000),
                iso: iso,
                completionHandler: nil
            )
        } else if device.isExposureModeSupported(.continuousAutoExposure) {
            if device.exposureMode != .continuousAutoExposure {
                device.exposureMode = .continuousAutoExposure
            }
            let bias = Float(clamp(desired.bias, Double(device.minExposureTargetBias), Double(device.maxExposureTargetBias)))
            device.setExposureTargetBias(bias, completionHandler: nil)
        }

        if desired.manualFocus, device.isLockingFocusWithCustomLensPositionSupported {
            device.setFocusModeLocked(lensPosition: Float(clamp(desired.lensPosition, 0, 1)), completionHandler: nil)
        } else if device.isFocusModeSupported(.continuousAutoFocus), device.focusMode != .continuousAutoFocus {
            device.focusMode = .continuousAutoFocus
        }

        if desired.manualWB, device.isLockingWhiteBalanceWithCustomDeviceGainsSupported {
            let values = AVCaptureDevice.WhiteBalanceTemperatureAndTintValues(
                temperature: Float(clamp(desired.temperature, 1500, 12000)),
                tint: Float(clamp(desired.tint, -150, 150))
            )
            let gains = normalized(device.deviceWhiteBalanceGains(for: values), device: device)
            device.setWhiteBalanceModeLocked(with: gains, completionHandler: nil)
        } else if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance),
                  device.whiteBalanceMode != .continuousAutoWhiteBalance {
            device.whiteBalanceMode = .continuousAutoWhiteBalance
        }
    }

    private func normalized(_ g: AVCaptureDevice.WhiteBalanceGains, device: AVCaptureDevice) -> AVCaptureDevice.WhiteBalanceGains {
        let maxGain = device.maxWhiteBalanceGain
        return AVCaptureDevice.WhiteBalanceGains(
            redGain: clamp(g.redGain, 1, maxGain),
            greenGain: clamp(g.greenGain, 1, maxGain),
            blueGain: clamp(g.blueGain, 1, maxGain)
        )
    }

    /// Autofocus/autoexposure point of interest (frame coordinates 0…1, top-left is 0,0).
    private func setPointOfInterest(_ point: CGPoint) {
        guard let device else { return }
        do { try device.lockForConfiguration() } catch { return }
        defer { device.unlockForConfiguration() }
        if !desired.manualFocus, device.isFocusPointOfInterestSupported {
            device.focusPointOfInterest = point
            if device.isFocusModeSupported(.autoFocus) { device.focusMode = .autoFocus }
        }
        if !desired.manualExposure, device.isExposurePointOfInterestSupported,
           device.isExposureModeSupported(.continuousAutoExposure) {
            device.exposurePointOfInterest = point
            device.exposureMode = .continuousAutoExposure
        }
    }

    // MARK: - State

    func state() -> CameraState {
        var s = sessionQueue.sync { () -> CameraState in
            var s = CameraState()
            s.error = setupError
            s.running = session.isRunning
            s.lenses = lensInfo
            s.loupe = loupe
            guard let device else { return s }

            let format = device.activeFormat
            s.lens = device.uniqueID
            let dims = photoOutput.maxPhotoDimensions
            s.resolution = "\(dims.width)×\(dims.height)"

            s.zoom = Double(device.videoZoomFactor)
            s.minZoom = Double(device.minAvailableVideoZoomFactor)
            s.maxZoom = Double(min(device.maxAvailableVideoZoomFactor, 20))

            s.exposureMode = desired.manualExposure ? "manual" : "auto"
            s.iso = Double(device.iso)
            s.minISO = Double(format.minISO)
            s.maxISO = Double(format.maxISO)
            s.shutter = device.exposureDuration.seconds
            s.minShutter = format.minExposureDuration.seconds
            s.maxShutter = format.maxExposureDuration.seconds
            s.bias = Double(device.exposureTargetBias)
            s.minBias = Double(device.minExposureTargetBias)
            s.maxBias = Double(device.maxExposureTargetBias)
            s.exposureOffset = Double(device.exposureTargetOffset)

            s.focusMode = desired.manualFocus ? "manual" : "auto"
            s.lensPosition = Double(device.lensPosition)
            s.manualFocusSupported = device.isLockingFocusWithCustomLensPositionSupported

            s.wbMode = desired.manualWB ? "manual" : "auto"
            let tt = device.temperatureAndTintValues(for: device.deviceWhiteBalanceGains)
            s.temperature = Double(tt.temperature)
            s.tint = Double(tt.tint)
            s.manualWBSupported = device.isLockingWhiteBalanceWithCustomDeviceGainsSupported

            var formats = ["heif", "jpeg"]
            if !photoOutput.availablePhotoCodecTypes.contains(.hevc) { formats.removeFirst() }
            let raw = photoOutput.availableRawPhotoPixelFormatTypes
            if raw.contains(where: { AVCapturePhotoOutput.isBayerRAWPixelFormat($0) }) { formats.append("raw") }
            if raw.contains(where: { AVCapturePhotoOutput.isAppleProRAWPixelFormat($0) }) { formats.append("proraw") }
            s.formats = formats
            return s
        }
        lock.lock()
        s.capture = captureStatus
        s.battery = battery.level
        s.charging = battery.charging
        lock.unlock()
        s.photoCount = store.count
        switch ProcessInfo.processInfo.thermalState {
        case .fair: s.thermal = "fair"
        case .serious: s.thermal = "serious"
        case .critical: s.thermal = "critical"
        default: s.thermal = "nominal"
        }
        return s
    }

    // MARK: - Capture

    func capture(_ request: CaptureRequest) -> String? {
        lock.lock()
        defer { lock.unlock() }
        if captureStatus.busy { return "A capture is already in progress" }
        captureStatus = CaptureStatus(busy: true, total: request.count, done: 0, countdown: Int(request.delay.rounded(.up)))
        cancelRequested = false
        lastRequest = request
        if request.saveToPhotos {
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { _ in }
        }
        seriesQueue.async { [self] in runSeries(request) }
        return nil
    }

    /// Shutter button on the iPhone: one frame with the format/resolution/delay last used
    /// from the remote (the delay matters — touching the phone shakes the tripod).
    func quickCapture() {
        lock.lock()
        var request = lastRequest
        lock.unlock()
        request.count = 1
        request.interval = 0
        _ = capture(request)
    }

    func cancelCapture() {
        lock.lock()
        cancelRequested = true
        lock.unlock()
    }

    private var isCancelled: Bool {
        lock.lock(); defer { lock.unlock() }
        return cancelRequested
    }

    private func updateStatus(_ change: (inout CaptureStatus) -> Void) {
        lock.lock()
        change(&captureStatus)
        lock.unlock()
    }

    /// Waits `seconds`, checking for cancellation every 100 ms. Returns false if cancelled.
    private func wait(_ seconds: Double) -> Bool {
        var left = seconds
        while left > 0 {
            if isCancelled { return false }
            Thread.sleep(forTimeInterval: min(0.1, left))
            left -= 0.1
        }
        return !isCancelled
    }

    private func runSeries(_ request: CaptureRequest) {
        // Delay before the first frame so the tripod stops shaking.
        var remaining = Int(request.delay.rounded(.up))
        while remaining > 0 {
            updateStatus { $0.countdown = remaining }
            if !wait(1) { break }
            remaining -= 1
        }
        updateStatus { $0.countdown = 0 }

        for index in 0..<request.count {
            if isCancelled { break }
            let started = Date()
            let semaphore = DispatchSemaphore(value: 0)
            var error: String?
            sessionQueue.async { [self] in
                captureOne(request) { err in
                    error = err
                    semaphore.signal()
                }
            }
            if semaphore.wait(timeout: .now() + 60) == .timedOut { error = "The camera did not respond" }
            updateStatus {
                $0.done = index + 1
                if let error { $0.lastError = error }
            }
            if error != nil { break }
            if index < request.count - 1 {
                // The interval is measured from the start of the previous frame.
                let pause = request.interval - Date().timeIntervalSince(started)
                if pause > 0 && !wait(pause) { break }
            }
        }
        updateStatus { $0.busy = false; $0.countdown = 0 }
    }

    private func captureOne(_ request: CaptureRequest, completion: @escaping (String?) -> Void) {
        guard session.isRunning else { completion("The camera is not running"); return }
        // Make sure the frame is shot with the user's settings, even if iOS reset them since.
        if hasManualSettings { applyAll() }

        let format = request.format
        let saveToPhotos = request.saveToPhotos
        let dimensions = photoDimensions(fullResolution: request.resolution != "12mp")
        let settings: AVCapturePhotoSettings
        let ext: String
        let raw = photoOutput.availableRawPhotoPixelFormatTypes

        switch format {
        case "raw":
            guard let type = raw.first(where: { AVCapturePhotoOutput.isBayerRAWPixelFormat($0) }) else {
                completion("RAW is not available for this lens"); return
            }
            settings = AVCapturePhotoSettings(rawPixelFormatType: type)
            ext = "dng"
        case "proraw":
            guard let type = raw.first(where: { AVCapturePhotoOutput.isAppleProRAWPixelFormat($0) }) else {
                completion("ProRAW is not available on this iPhone"); return
            }
            settings = AVCapturePhotoSettings(rawPixelFormatType: type)
            settings.maxPhotoDimensions = dimensions
            ext = "dng"
        case "jpeg":
            settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
            settings.maxPhotoDimensions = dimensions
            // In manual mode use minimal "smart" processing so the frame matches the settings.
            settings.photoQualityPrioritization = desired.manualExposure ? .speed : .quality
            ext = "jpg"
        default:
            if photoOutput.availablePhotoCodecTypes.contains(.hevc) {
                settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.hevc])
                ext = "heic"
            } else {
                settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
                ext = "jpg"
            }
            settings.maxPhotoDimensions = dimensions
            settings.photoQualityPrioritization = desired.manualExposure ? .speed : .quality
        }

        let id = settings.uniqueID
        let processor = PhotoProcessor { [weak self] data, error in
            guard let self else { return }
            self.lock.lock()
            self.processors[id] = nil
            self.lock.unlock()
            // Restore manual settings right after the shot in case the capture reset them.
            self.sessionQueue.async { if self.hasManualSettings { self.applyAll() } }
            guard let data else {
                completion(error ?? "Empty frame")
                return
            }
            do {
                try self.store.save(data, ext: ext)
                if saveToPhotos { Self.saveToLibrary(data) }
                completion(nil)
            } catch {
                completion("Could not save: \(error.localizedDescription)")
            }
        }
        lock.lock()
        processors[id] = processor
        lock.unlock()
        photoOutput.capturePhoto(with: settings, delegate: processor)
    }

    /// Full sensor resolution (up to 48 MP) or the standard ~12 MP size. 12 MP avoids the
    /// sensor mode switch that a 48 MP capture needs.
    private func photoDimensions(fullResolution: Bool) -> CMVideoDimensions {
        guard !fullResolution, let device else { return photoOutput.maxPhotoDimensions }
        let area = { (d: CMVideoDimensions) in Int(d.width) * Int(d.height) }
        let sizes = device.activeFormat.supportedMaxPhotoDimensions.sorted { area($0) < area($1) }
        let standard = sizes.first { area($0) >= 10_000_000 } ?? sizes.last
        guard let standard, area(standard) <= area(photoOutput.maxPhotoDimensions) else {
            return photoOutput.maxPhotoDimensions
        }
        return standard
    }

    private static func saveToLibrary(_ data: Data) {
        PHPhotoLibrary.shared().performChanges({
            PHAssetCreationRequest.forAsset().addResource(with: .photo, data: data, options: nil)
        }, completionHandler: nil)
    }
}

// MARK: - Preview for the remote (MJPEG)

extension CameraController: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard frames.hasClients else { return }
        let now = CACurrentMediaTime()
        guard now - lastFrameTime >= 1.0 / 15 else { return }
        lastFrameTime = now
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        var image = CIImage(cvPixelBuffer: pixelBuffer)
        let extent = image.extent
        let loupe = self.loupe
        if loupe > 1 {
            // Loupe: the center of the frame without downscaling — for precise focusing.
            let w = extent.width / loupe
            let h = extent.height / loupe
            image = image.cropped(to: CGRect(x: extent.midX - w / 2, y: extent.midY - h / 2, width: w, height: h))
        }
        image = image.transformed(by: CGAffineTransform(translationX: -image.extent.minX, y: -image.extent.minY))
        let scale = min(1, 1280 / image.extent.width)
        if scale < 1 {
            image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let jpeg = ciContext.jpegRepresentation(
                of: image,
                colorSpace: colorSpace,
                options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.7]
              ) else { return }
        frames.broadcast(jpeg)
    }
}

/// Delegate for a single shot. Kept in `processors` until the capture finishes.
final class PhotoProcessor: NSObject, AVCapturePhotoCaptureDelegate {
    private let completion: (Data?, String?) -> Void
    private var data: Data?
    private var error: String?

    init(completion: @escaping (Data?, String?) -> Void) {
        self.completion = completion
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        if let error {
            self.error = error.localizedDescription
            return
        }
        data = photo.fileDataRepresentation()
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings, error: Error?) {
        if let error, self.error == nil { self.error = error.localizedDescription }
        completion(data, self.error)
    }
}
