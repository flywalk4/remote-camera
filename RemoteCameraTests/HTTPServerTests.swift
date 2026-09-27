import XCTest
@testable import RemoteCamera

final class HTTPParserTests: XCTestCase {
    private func parse(_ raw: String) -> HTTPRequest? {
        HTTPServer.parse(Data(raw.utf8))
    }

    func testParsesGetWithQuery() throws {
        let request = try XCTUnwrap(parse("GET /photos/IMG_1.jpg?download=1 HTTP/1.1\r\nHost: iphone\r\n\r\n"))
        XCTAssertEqual(request.method, "GET")
        XCTAssertEqual(request.path, "/photos/IMG_1.jpg")
        XCTAssertEqual(request.query["download"], "1")
        XCTAssertTrue(request.body.isEmpty)
    }

    func testWaitsForCompleteHeaders() {
        XCTAssertNil(parse("GET / HTTP/1.1\r\nHost: iphone\r\n"))
    }

    func testWaitsForCompleteBody() throws {
        let head = "POST /api/settings HTTP/1.1\r\nContent-Length: 11\r\n\r\n"
        XCTAssertNil(parse(head + "{\"iso\":"))
        let request = try XCTUnwrap(parse(head + "{\"iso\":100}"))
        XCTAssertEqual(String(data: request.body, encoding: .utf8), "{\"iso\":100}")
    }

    func testContentLengthIsCaseInsensitive() throws {
        let request = try XCTUnwrap(parse("POST /x HTTP/1.1\r\ncontent-length: 2\r\n\r\nok"))
        XCTAssertEqual(request.body, Data("ok".utf8))
    }

    func testDecodesPercentEncodedPath() throws {
        let request = try XCTUnwrap(parse("GET /photos/IMG%201.jpg HTTP/1.1\r\n\r\n"))
        XCTAssertEqual(request.path, "/photos/IMG 1.jpg")
    }

    func testRejectsMalformedRequestLine() {
        XCTAssertNil(parse("GARBAGE\r\n\r\n"))
    }

    func testFrameBroadcasterStartsWithoutClients() {
        XCTAssertFalse(FrameBroadcaster().hasClients)
    }
}

/// Starts the real server on a local port and talks to it over HTTP.
final class HTTPServerIntegrationTests: XCTestCase {
    private var server: HTTPServer!
    private var store: PhotoStore!
    private var directory: URL!
    private var port: UInt16 = 0
    private static var nextPort: UInt16 = 18_080

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        store = PhotoStore(directory: directory)
        let frames = FrameBroadcaster()
        let api = WebAPI(camera: CameraController(store: store, frames: frames), store: store)
        server = HTTPServer(frames: frames) { api.handle($0) }
        // A fresh port per test, so a previous listener can never answer.
        Self.nextPort += 1
        port = Self.nextPort
        try server.start(port: port)
    }

    override func tearDownWithError() throws {
        server.stop()
        try? FileManager.default.removeItem(at: directory)
    }

    /// The listener becomes ready asynchronously — retry briefly.
    private func fetch(_ path: String, method: String = "GET", body: Data? = nil) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
        request.httpMethod = method
        request.httpBody = body
        var lastError: Error?
        for _ in 0..<20 {
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                return (data, try XCTUnwrap(response as? HTTPURLResponse))
            } catch {
                lastError = error
                try await Task.sleep(nanoseconds: 200_000_000)
            }
        }
        throw lastError ?? URLError(.cannotConnectToHost)
    }

    func testServesStateAsJSON() async throws {
        let (data, response) = try await fetch("/api/state")
        XCTAssertEqual(response.statusCode, 200)
        XCTAssertEqual(response.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let state = try JSONDecoder().decode(CameraState.self, from: data)
        XCTAssertFalse(state.running)
    }

    func testServesTheWebRemote() async throws {
        let (data, response) = try await fetch("/")
        XCTAssertEqual(response.statusCode, 200)
        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains("<title>Remote Camera</title>"))
    }

    func testAcceptsSettingsAndRejectsBadJSON() async throws {
        let ok = try await fetch("/api/settings", method: "POST", body: Data("{\"iso\":100}".utf8))
        XCTAssertEqual(ok.1.statusCode, 200)
        let bad = try await fetch("/api/settings", method: "POST", body: Data("not json".utf8))
        XCTAssertEqual(bad.1.statusCode, 400)
    }

    func testDownloadsAStoredPhoto() async throws {
        let name = try store.save(Data([0xFF, 0xD8, 0xFF]), ext: "jpg")
        let (data, response) = try await fetch("/photos/\(name)?download=1")
        XCTAssertEqual(response.statusCode, 200)
        XCTAssertEqual(data, Data([0xFF, 0xD8, 0xFF]))
        XCTAssertEqual(response.value(forHTTPHeaderField: "Content-Disposition"), "attachment; filename=\"\(name)\"")
    }
}
