import Foundation
import Network

struct HTTPRequest {
    let method: String
    let path: String
    let query: [String: String]
    let body: Data
}

struct HTTPResponse {
    var status = 200
    var contentType = "application/json"
    var headers: [String: String] = [:]
    var body = Data()

    static func json<T: Encodable>(_ value: T) -> HTTPResponse {
        HTTPResponse(body: (try? JSONEncoder().encode(value)) ?? Data("{}".utf8))
    }

    static func error(_ message: String, status: Int = 400) -> HTTPResponse {
        HTTPResponse.json(["error": message]).with(status: status)
    }

    func with(status: Int) -> HTTPResponse {
        var copy = self
        copy.status = status
        return copy
    }
}

enum HTTPResult {
    case response(HTTPResponse)
    /// Endless stream of JPEG frames (multipart/x-mixed-replace) for the preview.
    case mjpeg
}

/// Minimal HTTP/1.1 server: one request per connection (Connection: close),
/// except for the MJPEG stream, which stays open.
final class HTTPServer: @unchecked Sendable {
    private let queue = DispatchQueue(label: "http.server")
    private var listener: NWListener?
    private let frames: FrameBroadcaster
    private let handler: (HTTPRequest) -> HTTPResult

    init(frames: FrameBroadcaster, handler: @escaping (HTTPRequest) -> HTTPResult) {
        self.frames = frames
        self.handler = handler
    }

    func start(port: UInt16) throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        let listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
        // Bonjour: the remote is also advertised as "Remote Camera" on the network.
        listener.service = NWListener.Service(name: "Remote Camera", type: "_http._tcp")
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.stateUpdateHandler = { [weak self] state in
            // iOS may close the socket after the app is backgrounded — restart it.
            if case .failed = state {
                self?.listener?.cancel()
                self?.queue.asyncAfter(deadline: .now() + 1) { try? self?.start(port: port) }
            }
        }
        listener.start(queue: queue)
        self.listener = listener
    }

    func stop() {
        listener?.stateUpdateHandler = nil
        listener?.cancel()
        listener = nil
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let request = Self.parse(buffer) {
                self.respond(to: request, on: connection)
            } else if isComplete || error != nil || buffer.count > 1 << 20 {
                connection.cancel()
            } else {
                self.receive(connection, buffer: buffer)
            }
        }
    }

    static func parse(_ buffer: Data) -> HTTPRequest? {
        guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)),
              let head = String(data: buffer.subdata(in: buffer.startIndex..<headerEnd.lowerBound), encoding: .utf8)
        else { return nil }

        var lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ")
        guard requestLine.count >= 2 else { return nil }

        var contentLength = 0
        for line in lines {
            let parts = line.split(separator: ":", maxSplits: 1)
            if parts.count == 2, parts[0].lowercased() == "content-length" {
                contentLength = Int(parts[1].trimmingCharacters(in: .whitespaces)) ?? 0
            }
        }
        let bodyStart = headerEnd.upperBound
        guard buffer.endIndex - bodyStart >= contentLength else { return nil }
        let body = buffer.subdata(in: bodyStart..<(bodyStart + contentLength))

        let components = URLComponents(string: String(requestLine[1]))
        var query: [String: String] = [:]
        for item in components?.queryItems ?? [] { query[item.name] = item.value ?? "" }
        return HTTPRequest(
            method: String(requestLine[0]),
            path: components?.path ?? "/",
            query: query,
            body: body
        )
    }

    private func respond(to request: HTTPRequest, on connection: NWConnection) {
        switch handler(request) {
        case .response(let response):
            send(response, on: connection)
        case .mjpeg:
            frames.add(connection)
        }
    }

    private func send(_ response: HTTPResponse, on connection: NWConnection) {
        var head = "HTTP/1.1 \(response.status) \(Self.reason(response.status))\r\n"
        head += "Content-Type: \(response.contentType)\r\n"
        head += "Content-Length: \(response.body.count)\r\n"
        head += "Cache-Control: no-store\r\n"
        head += "Connection: close\r\n"
        for (key, value) in response.headers { head += "\(key): \(value)\r\n" }
        head += "\r\n"
        var data = Data(head.utf8)
        data.append(response.body)
        connection.send(content: data, completion: .contentProcessed { _ in connection.cancel() })
    }

    private static func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 400: return "Bad Request"
        case 404: return "Not Found"
        case 409: return "Conflict"
        default: return "Error"
        }
    }
}

/// Sends preview JPEG frames to every connected remote.
/// Frames are skipped for a client that cannot keep up.
final class FrameBroadcaster: @unchecked Sendable {
    private let lock = NSLock()
    private var clients: [ObjectIdentifier: Client] = [:]

    private final class Client {
        let connection: NWConnection
        var busy = false
        init(_ connection: NWConnection) { self.connection = connection }
    }

    var hasClients: Bool {
        lock.lock(); defer { lock.unlock() }
        return !clients.isEmpty
    }

    func add(_ connection: NWConnection) {
        let head = "HTTP/1.1 200 OK\r\n" +
            "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n" +
            "Cache-Control: no-store\r\n" +
            "Connection: close\r\n\r\n"
        let id = ObjectIdentifier(connection)
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: self?.remove(id)
            default: break
            }
        }
        connection.send(content: Data(head.utf8), completion: .contentProcessed { [weak self] error in
            guard let self else { return }
            if error != nil { connection.cancel(); return }
            self.lock.lock()
            self.clients[id] = Client(connection)
            self.lock.unlock()
        })
    }

    private func remove(_ id: ObjectIdentifier) {
        lock.lock()
        clients[id] = nil
        lock.unlock()
    }

    func broadcast(_ jpeg: Data) {
        var part = Data("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: \(jpeg.count)\r\n\r\n".utf8)
        part.append(jpeg)
        part.append(Data("\r\n".utf8))

        lock.lock()
        let ready = clients.values.filter { !$0.busy }
        ready.forEach { $0.busy = true }
        lock.unlock()

        for client in ready {
            client.connection.send(content: part, completion: .contentProcessed { [weak self] error in
                guard let self else { return }
                if error != nil {
                    client.connection.cancel()
                    return
                }
                self.lock.lock()
                client.busy = false
                self.lock.unlock()
            })
        }
    }
}
