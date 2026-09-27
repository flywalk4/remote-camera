import Foundation

/// Photos are stored in the app's Documents/Photos folder. They are visible in the Files app
/// (On My iPhone → Remote Camera) and can be downloaded from the remote.
final class PhotoStore: @unchecked Sendable {
    struct Item: Codable {
        let name: String
        let size: Int
        let date: Double
    }

    let directory: URL
    private let lock = NSLock()
    private let formatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd_HHmmss_SSS"
        return f
    }()

    init() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        directory = documents.appendingPathComponent("Photos", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    @discardableResult
    func save(_ data: Data, ext: String) throws -> String {
        lock.lock()
        let name = "IMG_\(formatter.string(from: Date())).\(ext)"
        lock.unlock()
        try data.write(to: directory.appendingPathComponent(name), options: .atomic)
        return name
    }

    var count: Int {
        (try? FileManager.default.contentsOfDirectory(atPath: directory.path).count) ?? 0
    }

    func list() -> [Item] {
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        let urls = (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]
        )) ?? []
        return urls.compactMap { url -> Item? in
            guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            return Item(
                name: url.lastPathComponent,
                size: values.fileSize ?? 0,
                date: values.contentModificationDate?.timeIntervalSince1970 ?? 0
            )
        }
        .sorted { $0.date > $1.date }
    }

    /// File URL for a name from a request; nil if the name is suspicious or the file does not exist.
    func url(for name: String) -> URL? {
        guard !name.isEmpty, !name.contains("/"), !name.hasPrefix(".") else { return nil }
        let url = directory.appendingPathComponent(name)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    func delete(_ name: String) -> Bool {
        guard let url = url(for: name) else { return false }
        return (try? FileManager.default.removeItem(at: url)) != nil
    }
}
