import XCTest
@testable import RemoteCamera

final class PhotoStoreTests: XCTestCase {
    private var directory: URL!
    private var store: PhotoStore!

    override func setUp() {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        store = PhotoStore(directory: directory)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
    }

    func testSaveListAndDelete() throws {
        let name = try store.save(Data("photo".utf8), ext: "heic")
        XCTAssertTrue(name.hasPrefix("IMG_"))
        XCTAssertTrue(name.hasSuffix(".heic"))
        XCTAssertEqual(store.count, 1)

        let item = try XCTUnwrap(store.list().first)
        XCTAssertEqual(item.name, name)
        XCTAssertEqual(item.size, 5)

        XCTAssertTrue(store.delete(name))
        XCTAssertEqual(store.count, 0)
        XCTAssertFalse(store.delete(name))
    }

    func testQuickSavesNeverOverwriteEachOther() throws {
        let names = try (0..<20).map { _ in try store.save(Data("x".utf8), ext: "dng") }
        XCTAssertEqual(Set(names).count, 20)
        XCTAssertEqual(store.count, 20)
    }

    func testListIsNewestFirst() throws {
        let first = try store.save(Data("1".utf8), ext: "jpg")
        let old = Date(timeIntervalSinceNow: -60)
        try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: directory.appendingPathComponent(first).path)
        let second = try store.save(Data("2".utf8), ext: "jpg")
        XCTAssertEqual(store.list().map(\.name), [second, first])
    }

    func testRefusesSuspiciousNames() throws {
        _ = try store.save(Data("x".utf8), ext: "jpg")
        for name in ["", "../x.jpg", "a/b.jpg", ".hidden", "..", "missing.jpg"] {
            XCTAssertNil(store.url(for: name), name)
            XCTAssertFalse(store.delete(name), name)
        }
    }
}
