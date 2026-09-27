import XCTest
@testable import RemoteCamera

/// Routes of the API the Mac remote uses. The camera is never started here,
/// so these tests run on the simulator (which has no camera).
final class WebAPITests: XCTestCase {
    private var directory: URL!
    private var store: PhotoStore!
    private var camera: CameraController!
    private var api: WebAPI!

    override func setUp() {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        store = PhotoStore(directory: directory)
        camera = CameraController(store: store, frames: FrameBroadcaster())
        api = WebAPI(camera: camera, store: store)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
    }

    private func request(_ method: String, _ target: String, body: String = "") -> HTTPResult {
        let raw = "\(method) \(target) HTTP/1.1\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)"
        return api.handle(HTTPServer.parse(Data(raw.utf8))!)
    }

    private func response(_ method: String, _ target: String, body: String = "",
                          file: StaticString = #filePath, line: UInt = #line) throws -> HTTPResponse {
        guard case .response(let response) = request(method, target, body: body) else {
            XCTFail("Expected a regular response", file: file, line: line)
            throw XCTSkip()
        }
        return response
    }

    func testServesBundledWebFiles() throws {
        for (path, type) in [("/", "text/html"), ("/app.js", "text/javascript"), ("/style.css", "text/css")] {
            let r = try response("GET", path)
            XCTAssertEqual(r.status, 200, path)
            XCTAssertTrue(r.contentType.hasPrefix(type), path)
            XCTAssertFalse(r.body.isEmpty, path)
        }
    }

    func testStateDescribesACameraThatIsNotRunning() throws {
        let r = try response("GET", "/api/state")
        let state = try JSONDecoder().decode(CameraState.self, from: r.body)
        XCTAssertFalse(state.running)
        XCTAssertEqual(state.exposureMode, "auto")
        XCTAssertFalse(state.capture.busy)
        XCTAssertEqual(state.photoCount, 0)
    }

    func testStreamRouteReturnsMJPEG() {
        guard case .mjpeg = request("GET", "/stream") else {
            return XCTFail("Expected the MJPEG stream")
        }
    }

    func testSettingsValidation() throws {
        XCTAssertEqual(try response("POST", "/api/settings", body: "{\"iso\":100,\"lensPosition\":0.9}").status, 200)
        XCTAssertEqual(try response("POST", "/api/settings", body: "nope").status, 400)
    }

    func testListsDownloadsAndDeletesPhotos() throws {
        let name = try store.save(Data("jpeg".utf8), ext: "jpg")

        let list = try JSONDecoder().decode([PhotoStore.Item].self, from: try response("GET", "/api/photos").body)
        XCTAssertEqual(list.map(\.name), [name])

        let file = try response("GET", "/photos/\(name)")
        XCTAssertEqual(file.contentType, "image/jpeg")
        XCTAssertEqual(file.body, Data("jpeg".utf8))
        XCTAssertNil(file.headers["Content-Disposition"])
        XCTAssertNotNil(try response("GET", "/photos/\(name)?download=1").headers["Content-Disposition"])

        XCTAssertEqual(try response("POST", "/api/photos/delete", body: "{\"name\":\"\(name)\"}").status, 200)
        XCTAssertEqual(try response("POST", "/api/photos/delete", body: "{\"name\":\"\(name)\"}").status, 404)
        XCTAssertEqual(store.count, 0)
    }

    func testContentTypesByExtension() throws {
        let dng = try store.save(Data("raw".utf8), ext: "dng")
        let heic = try store.save(Data("heic".utf8), ext: "heic")
        XCTAssertEqual(try response("GET", "/photos/\(dng)").contentType, "image/x-adobe-dng")
        XCTAssertEqual(try response("GET", "/photos/\(heic)").contentType, "image/heic")
    }

    func testRefusesPathTraversal() throws {
        XCTAssertEqual(try response("GET", "/photos/..%2F..%2FLibrary%2Fsecret").status, 404)
        XCTAssertEqual(try response("GET", "/photos/.hidden").status, 404)
    }

    func testUnknownRouteIs404() throws {
        XCTAssertEqual(try response("GET", "/nope").status, 404)
        XCTAssertEqual(try response("DELETE", "/api/state").status, 404)
    }

    func testCaptureWithoutARunningCameraReportsAnError() throws {
        XCTAssertEqual(try response("POST", "/api/capture", body: "{\"count\":1}").status, 200)
        let deadline = Date().addingTimeInterval(5)
        var status = camera.state().capture
        while status.busy && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
            status = camera.state().capture
        }
        XCTAssertFalse(status.busy)
        XCTAssertEqual(status.lastError, "The camera is not running")
        XCTAssertEqual(store.count, 0)
    }

    func testSecondCaptureWhileBusyIsRefused() throws {
        XCTAssertEqual(try response("POST", "/api/capture", body: "{\"delay\":2}").status, 200)
        XCTAssertEqual(try response("POST", "/api/capture", body: "{}").status, 409)
        XCTAssertEqual(try response("POST", "/api/cancel").status, 200)
    }
}
