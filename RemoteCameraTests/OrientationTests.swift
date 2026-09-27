import AVFoundation
import CoreImage
import XCTest
@testable import RemoteCamera

final class OrientationTests: XCTestCase {
    typealias O = OrientationMonitor.Orientation

    func testOrientationFromGravity() {
        XCTAssertEqual(OrientationMonitor.orientation(x: 0, y: -1), .portrait)
        XCTAssertEqual(OrientationMonitor.orientation(x: 0, y: 1), .portraitUpsideDown)
        XCTAssertEqual(OrientationMonitor.orientation(x: -1, y: 0), .landscapeLeft)
        XCTAssertEqual(OrientationMonitor.orientation(x: 1, y: 0), .landscapeRight)
        // Tilted up towards the Moon but still clearly upright.
        XCTAssertEqual(OrientationMonitor.orientation(x: 0.1, y: -0.5), .portrait)
    }

    func testFlatPhoneKeepsTheLastOrientation() {
        XCTAssertNil(OrientationMonitor.orientation(x: 0.1, y: -0.2))
    }

    func testBackCameraMapping() {
        XCTAssertEqual(OrientationMonitor.imageOrientation(for: .portrait), .right)
        XCTAssertEqual(OrientationMonitor.imageOrientation(for: .landscapeLeft), .up)
        XCTAssertEqual(OrientationMonitor.imageOrientation(for: .landscapeRight), .down)
        XCTAssertEqual(OrientationMonitor.imageOrientation(for: .portraitUpsideDown), .left)

        XCTAssertEqual(OrientationMonitor.rotationAngle(for: .portrait), 90)
        XCTAssertEqual(OrientationMonitor.rotationAngle(for: .landscapeLeft), 0)
        XCTAssertEqual(OrientationMonitor.videoOrientation(for: .portrait), .portrait)
        XCTAssertEqual(OrientationMonitor.videoOrientation(for: .landscapeLeft), .landscapeRight)
    }

    func testPreviewPointsMapBackToTheSensor() {
        let all: [O] = [.portrait, .portraitUpsideDown, .landscapeLeft, .landscapeRight]
        for o in all {
            let center = OrientationMonitor.sensorPoint(x: 0.5, y: 0.5, for: o)
            XCTAssertEqual(center.x, 0.5, accuracy: 1e-9)
            XCTAssertEqual(center.y, 0.5, accuracy: 1e-9)
        }
        // Portrait preview = sensor rotated 90° clockwise, so the preview's top-left
        // corner is the sensor's bottom-left corner.
        let p = OrientationMonitor.sensorPoint(x: 0, y: 0, for: .portrait)
        XCTAssertEqual(p.x, 0)
        XCTAssertEqual(p.y, 1)
        let l = OrientationMonitor.sensorPoint(x: 0.2, y: 0.3, for: .landscapeLeft)
        XCTAssertEqual(l.x, 0.2)
        XCTAssertEqual(l.y, 0.3)
    }

    /// A landscape sensor frame becomes a portrait preview when the phone stands upright.
    func testRotatedFrameShape() {
        let sensor = CIImage(color: .red).cropped(to: CGRect(x: 0, y: 0, width: 400, height: 300))
        let all: [O] = [.portrait, .portraitUpsideDown, .landscapeLeft, .landscapeRight]
        for o in all {
            let rotated = sensor.oriented(OrientationMonitor.imageOrientation(for: o))
            let portrait = o == .portrait || o == .portraitUpsideDown
            XCTAssertEqual(rotated.extent.width, portrait ? 300 : 400, "\(o)")
            XCTAssertEqual(rotated.extent.height, portrait ? 400 : 300, "\(o)")
        }
    }
}
