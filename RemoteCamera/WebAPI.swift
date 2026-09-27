import Foundation

/// HTTP API routes used by the web remote on the Mac.
///
///   GET  /                    web remote (files from the Web folder)
///   GET  /stream              MJPEG preview
///   GET  /api/state           camera state
///   POST /api/settings        change settings (SettingsUpdate)
///   POST /api/capture         take a photo / series (CaptureRequest)
///   POST /api/cancel          cancel a series
///   GET  /api/photos          list photos
///   GET  /photos/<name>       download a photo (?download=1 — as attachment)
///   POST /api/photos/delete   delete a photo {"name": "..."}
struct WebAPI {
    let camera: CameraController
    let store: PhotoStore

    private static let staticFiles: [String: (file: String, type: String)] = [
        "/": ("index.html", "text/html; charset=utf-8"),
        "/index.html": ("index.html", "text/html; charset=utf-8"),
        "/app.js": ("app.js", "text/javascript; charset=utf-8"),
        "/style.css": ("style.css", "text/css; charset=utf-8"),
    ]

    func handle(_ request: HTTPRequest) -> HTTPResult {
        let path = request.path

        if request.method == "GET", let entry = Self.staticFiles[path] {
            return .response(staticFile(entry.file, type: entry.type))
        }

        switch (request.method, path) {
        case ("GET", "/stream"):
            return .mjpeg

        case ("GET", "/api/state"):
            return .response(.json(camera.state()))

        case ("POST", "/api/settings"):
            guard let update = try? JSONDecoder().decode(SettingsUpdate.self, from: request.body) else {
                return .response(.error("Invalid JSON"))
            }
            camera.apply(update)
            return .response(.json(["ok": true]))

        case ("POST", "/api/capture"):
            let capture = (try? JSONDecoder().decode(CaptureRequest.self, from: request.body)) ?? CaptureRequest()
            if let error = camera.capture(capture) {
                return .response(.error(error, status: 409))
            }
            return .response(.json(["ok": true]))

        case ("POST", "/api/cancel"):
            camera.cancelCapture()
            return .response(.json(["ok": true]))

        case ("GET", "/api/photos"):
            return .response(.json(store.list()))

        case ("POST", "/api/photos/delete"):
            struct Body: Decodable { let name: String }
            guard let body = try? JSONDecoder().decode(Body.self, from: request.body), store.delete(body.name) else {
                return .response(.error("File not found", status: 404))
            }
            return .response(.json(["ok": true]))

        default:
            if request.method == "GET", path.hasPrefix("/photos/") {
                return .response(photo(named: String(path.dropFirst("/photos/".count)), download: request.query["download"] != nil))
            }
            return .response(.error("Not found", status: 404))
        }
    }

    private func staticFile(_ name: String, type: String) -> HTTPResponse {
        guard let url = Bundle.main.url(forResource: name, withExtension: nil, subdirectory: "Web"),
              let data = try? Data(contentsOf: url) else {
            return .error("File \(name) is missing from the app bundle", status: 404)
        }
        return HTTPResponse(contentType: type, body: data)
    }

    private func photo(named name: String, download: Bool) -> HTTPResponse {
        guard let url = store.url(for: name), let data = try? Data(contentsOf: url) else {
            return .error("File not found", status: 404)
        }
        let type: String
        switch url.pathExtension.lowercased() {
        case "jpg", "jpeg": type = "image/jpeg"
        case "heic": type = "image/heic"
        case "dng": type = "image/x-adobe-dng"
        default: type = "application/octet-stream"
        }
        var response = HTTPResponse(contentType: type, body: data)
        if download {
            response.headers["Content-Disposition"] = "attachment; filename=\"\(name)\""
        }
        return response
    }
}
