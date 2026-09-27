import XCTest
@testable import RemoteCamera

final class CaptureRequestTests: XCTestCase {
    private func decode(_ json: String) throws -> CaptureRequest {
        try JSONDecoder().decode(CaptureRequest.self, from: Data(json.utf8))
    }

    func testDefaults() throws {
        let r = try decode("{}")
        XCTAssertEqual(r.format, "heif")
        XCTAssertEqual(r.count, 1)
        XCTAssertEqual(r.interval, 0)
        XCTAssertEqual(r.delay, 0)
        XCTAssertFalse(r.saveToPhotos)
        XCTAssertEqual(r.resolution, "max")
    }

    func testDecodesEverything() throws {
        let r = try decode(#"{"format":"raw","count":50,"interval":0.5,"delay":2,"saveToPhotos":true,"resolution":"12mp"}"#)
        XCTAssertEqual(r.format, "raw")
        XCTAssertEqual(r.count, 50)
        XCTAssertEqual(r.interval, 0.5)
        XCTAssertEqual(r.delay, 2)
        XCTAssertTrue(r.saveToPhotos)
        XCTAssertEqual(r.resolution, "12mp")
    }

    func testClampsOutOfRangeValues() throws {
        let low = try decode(#"{"count":0,"interval":-3,"delay":-1}"#)
        XCTAssertEqual(low.count, 1)
        XCTAssertEqual(low.interval, 0)
        XCTAssertEqual(low.delay, 0)

        let high = try decode(#"{"count":100000,"delay":600}"#)
        XCTAssertEqual(high.count, 9999)
        XCTAssertEqual(high.delay, 60)
    }
}

final class SettingsAndStateTests: XCTestCase {
    func testSettingsUpdateDecodesAnySubset() throws {
        let u = try JSONDecoder().decode(SettingsUpdate.self, from: Data(#"{"iso":100,"point":{"x":0.25,"y":0.75}}"#.utf8))
        XCTAssertEqual(u.iso, 100)
        XCTAssertEqual(u.point?.x, 0.25)
        XCTAssertEqual(u.point?.y, 0.75)
        XCTAssertNil(u.shutter)
        XCTAssertNil(u.lens)
    }

    /// The web remote reads these exact keys (Web/app.js).
    func testStateJSONHasTheKeysTheRemoteUses() throws {
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(CameraState())) as? [String: Any])
        for key in ["running", "lenses", "lens", "resolution", "zoom", "minZoom", "maxZoom",
                    "exposureMode", "iso", "minISO", "maxISO", "shutter", "minShutter", "maxShutter",
                    "bias", "minBias", "maxBias", "exposureOffset", "focusMode", "lensPosition",
                    "manualFocusSupported", "wbMode", "temperature", "tint", "manualWBSupported",
                    "loupe", "orientation", "formats", "capture", "photoCount", "battery", "charging", "thermal"] {
            XCTAssertNotNil(json[key], "missing \(key)")
        }
        let capture = try XCTUnwrap(json["capture"] as? [String: Any])
        for key in ["busy", "total", "done", "countdown"] {
            XCTAssertNotNil(capture[key], "missing capture.\(key)")
        }
    }

    func testClamp() {
        XCTAssertEqual(clamp(5, 0, 10), 5)
        XCTAssertEqual(clamp(-1, 0, 10), 0)
        XCTAssertEqual(clamp(11.5, 0, 10), 10)
    }
}

final class SliderMathTests: XCTestCase {
    func testLogScaleEndsAndMiddle() {
        XCTAssertEqual(CameraControlsView.toLog(32, 32, 3072), 0, accuracy: 1e-9)
        XCTAssertEqual(CameraControlsView.toLog(3072, 32, 3072), 1, accuracy: 1e-9)
        // The middle of a log scale is the geometric mean.
        XCTAssertEqual(CameraControlsView.toLog((32.0 * 3072).squareRoot(), 32, 3072), 0.5, accuracy: 1e-9)
    }

    func testLogScaleRoundTrip() {
        for iso in [32.0, 50, 100, 400, 1600, 3072] {
            let pos = CameraControlsView.toLog(iso, 32, 3072)
            XCTAssertEqual(CameraControlsView.fromLog(pos, 32, 3072), iso, accuracy: 1e-6)
        }
    }

    func testLogScaleIsSafeWithBadRanges() {
        XCTAssertEqual(CameraControlsView.toLog(100, 0, 0), 0)
        XCTAssertEqual(CameraControlsView.toLog(0, 32, 3072), 0)
        XCTAssertEqual(CameraControlsView.toLog(99_999, 32, 3072), 1)
    }

    func testShutterText() {
        XCTAssertEqual(CameraControlsView.shutterText(1.0 / 250), "1/250")
        XCTAssertEqual(CameraControlsView.shutterText(1.0 / 8000), "1/8000")
        XCTAssertEqual(CameraControlsView.shutterText(1), "1.0 s")
        XCTAssertEqual(CameraControlsView.shutterText(0), "—")
    }

    func testLensFactorText() {
        XCTAssertEqual(CameraControlsView.factor(0.5), "0.5×")
        XCTAssertEqual(CameraControlsView.factor(1), "1×")
        XCTAssertEqual(CameraControlsView.factor(5), "5×")
    }
}
