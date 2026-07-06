import Foundation
import OpenClawKit
import SQLite3
import Testing
@testable import OpenClawChatUI

private func makeDatabaseURL() throws -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("chat-cache-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("chat-cache.sqlite", isDirectory: false)
}

private func cacheMessage(
    role: String,
    text: String,
    timestamp: Double,
    idempotencyKey: String? = nil) -> OpenClawChatMessage
{
    OpenClawChatMessage(
        role: role,
        content: [
            OpenClawChatMessageContent(
                type: "text",
                text: text,
                mimeType: nil,
                fileName: nil,
                content: nil),
        ],
        timestamp: timestamp,
        idempotencyKey: idempotencyKey)
}

private func cacheSessionEntry(key: String, updatedAt: Double) -> OpenClawChatSessionEntry {
    OpenClawChatSessionEntry(
        key: key,
        kind: nil,
        displayName: nil,
        surface: nil,
        subject: nil,
        room: nil,
        space: nil,
        updatedAt: updatedAt,
        sessionId: nil,
        systemSent: nil,
        abortedLastRun: nil,
        thinkingLevel: nil,
        verboseLevel: nil,
        inputTokens: nil,
        outputTokens: nil,
        totalTokens: nil,
        modelProvider: nil,
        model: nil,
        contextTokens: nil)
}

private func messageTexts(_ messages: [OpenClawChatMessage]) -> [String] {
    messages.map { $0.content.compactMap(\.text).joined() }
}

private func outboxCommand(
    id: String = UUID().uuidString,
    sessionKey: String = "main",
    text: String,
    thinking: String = "off",
    createdAt: Double = Date().timeIntervalSince1970) -> OpenClawChatOutboxCommand
{
    OpenClawChatOutboxCommand(
        id: id,
        sessionKey: sessionKey,
        text: text,
        thinking: thinking,
        createdAt: createdAt,
        status: .queued,
        retryCount: 0,
        lastError: nil)
}

struct ChatTranscriptCacheStoreTests {
    @Test func `transcript and sessions round trip`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")

        let messages = [
            cacheMessage(role: "user", text: "hello", timestamp: 1000, idempotencyKey: "run-1:user"),
            cacheMessage(role: "assistant", text: "hi there", timestamp: 2000, idempotencyKey: "run-1"),
        ]
        await store.storeTranscript(sessionKey: "main", messages: messages)
        await store.storeSessions([cacheSessionEntry(key: "main", updatedAt: 2000)])

        let loaded = await store.loadTranscript(sessionKey: "main")
        #expect(messageTexts(loaded) == ["hello", "hi there"])
        #expect(loaded.map(\.role) == ["user", "assistant"])
        #expect(loaded.map(\.idempotencyKey) == ["run-1:user", "run-1"])
        #expect(loaded.map(\.timestamp) == [1000, 2000])

        let sessions = await store.loadSessions()
        #expect(sessions.map(\.key) == ["main"])

        #expect(await store.loadTranscript(sessionKey: "unknown").isEmpty)
    }

    @Test func `transcript keeps only most recent messages within bound`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let bound = OpenClawChatSQLiteTranscriptCache.maxCachedMessagesPerSession

        let messages = (0..<(bound + 50)).map { index in
            cacheMessage(role: "user", text: "m\(index)", timestamp: Double(index))
        }
        await store.storeTranscript(sessionKey: "main", messages: messages)

        let loaded = await store.loadTranscript(sessionKey: "main")
        #expect(loaded.count == bound)
        #expect(messageTexts(loaded).first == "m50")
        #expect(messageTexts(loaded).last == "m\(bound + 49)")
    }

    @Test func `sessions list is bounded to most recently updated`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let bound = OpenClawChatSQLiteTranscriptCache.maxCachedSessions

        let sessions = (0..<(bound + 10)).map { index in
            cacheSessionEntry(key: "s\(index)", updatedAt: Double(index))
        }
        await store.storeSessions(sessions)

        let loaded = await store.loadSessions()
        #expect(loaded.count == bound)
        // Highest updatedAt survives, oldest entries are dropped.
        #expect(loaded.map(\.key).contains("s\(bound + 9)"))
        #expect(!loaded.map(\.key).contains("s0"))
    }

    @Test func `transcript eviction keeps most recent sessions`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let bound = OpenClawChatSQLiteTranscriptCache.maxCachedTranscripts

        for index in 0..<(bound + 5) {
            await store.storeTranscript(
                sessionKey: "s\(index)",
                messages: [cacheMessage(role: "user", text: "m\(index)", timestamp: Double(index))])
        }

        // The five oldest transcripts were evicted; the newest ones remain.
        for index in 0..<5 {
            #expect(await store.loadTranscript(sessionKey: "s\(index)").isEmpty)
        }
        for index in 5..<(bound + 5) {
            #expect(await !(store.loadTranscript(sessionKey: "s\(index)").isEmpty))
        }
    }

    @Test func `transcripts are scoped per gateway identity`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let storeA = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let storeB = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-b")

        await storeA.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "gateway A secret", timestamp: 1)])
        await storeA.storeSessions([cacheSessionEntry(key: "main", updatedAt: 1)])

        #expect(await storeB.loadTranscript(sessionKey: "main").isEmpty)
        #expect(await storeB.loadSessions().isEmpty)

        await storeB.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "gateway B", timestamp: 2)])
        #expect(await messageTexts(storeA.loadTranscript(sessionKey: "main")) == ["gateway A secret"])
        #expect(await messageTexts(storeB.loadTranscript(sessionKey: "main")) == ["gateway B"])
    }

    @Test func `empty transcript store clears cached row`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")

        await store.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "old", timestamp: 1)])
        await store.storeTranscript(sessionKey: "main", messages: [])
        #expect(await store.loadTranscript(sessionKey: "main").isEmpty)
    }

    @Test func `reset retirement permits physical removal of all gateway rows`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let storeA = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let storeB = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-b")
        await storeA.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "gateway A", timestamp: 1)])
        await storeA.storeSessions([cacheSessionEntry(key: "main", updatedAt: 1)])
        await storeB.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "gateway B", timestamp: 2)])

        await storeA.retire()
        await storeB.retire()
        OpenClawChatSQLiteTranscriptCache.removeDatabaseFiles(at: url)
        await storeA.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "late write", timestamp: 3)])

        let readerA = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let readerB = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-b")
        #expect(await storeA.loadTranscript(sessionKey: "main").isEmpty)
        #expect(await storeA.loadSessions().isEmpty)
        #expect(await readerA.loadTranscript(sessionKey: "main").isEmpty)
        #expect(await readerB.loadTranscript(sessionKey: "main").isEmpty)
    }

    @Test func `removing one gateway database preserves another`() async throws {
        let urlA = try makeDatabaseURL()
        let directory = urlA.deletingLastPathComponent()
        let urlB = directory.appendingPathComponent("chat-cache-b.sqlite", isDirectory: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storeA = OpenClawChatSQLiteTranscriptCache(databaseURL: urlA, gatewayID: "gw-a")
        let storeB = OpenClawChatSQLiteTranscriptCache(databaseURL: urlB, gatewayID: "gw-b")
        await storeA.storeSessions([cacheSessionEntry(key: "a", updatedAt: 1)])
        await storeA.storeTranscript(
            sessionKey: "a",
            messages: [cacheMessage(role: "user", text: "gateway A", timestamp: 1)])
        await storeB.storeSessions([cacheSessionEntry(key: "b", updatedAt: 2)])
        await storeB.storeTranscript(
            sessionKey: "b",
            messages: [cacheMessage(role: "user", text: "gateway B", timestamp: 2)])

        await storeA.retire()
        OpenClawChatSQLiteTranscriptCache.removeDatabaseFiles(at: urlA)

        let readerA = OpenClawChatSQLiteTranscriptCache(databaseURL: urlA, gatewayID: "gw-a")
        #expect(await readerA.loadSessions().isEmpty)
        #expect(await readerA.loadTranscript(sessionKey: "a").isEmpty)
        #expect(await storeB.loadSessions().map(\.key) == ["b"])
        #expect(await messageTexts(storeB.loadTranscript(sessionKey: "b")) == ["gateway B"])
    }

    @Test func `attachment payloads are not persisted`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")

        let message = OpenClawChatMessage(
            role: "user",
            content: [
                OpenClawChatMessageContent(
                    type: "text",
                    text: "See attached.",
                    mimeType: nil,
                    fileName: nil,
                    content: nil),
                OpenClawChatMessageContent(
                    type: "image",
                    text: nil,
                    mimeType: "image/png",
                    fileName: "photo.png",
                    content: AnyCodable("aGVsbG8tYmluYXJ5LWJsb2I=")),
            ],
            timestamp: 1000)
        await store.storeTranscript(sessionKey: "main", messages: [message])

        let loaded = await store.loadTranscript(sessionKey: "main")
        let items = try #require(loaded.first?.content)
        #expect(items.count == 2)
        // Text and small descriptors survive; binary payloads never hit disk.
        #expect(items[0].text == "See attached.")
        #expect(items[1].fileName == "photo.png")
        #expect(items[1].content == nil)
    }

    @Test func `v1 transcript cache migrates to durable outbox schema`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        do {
            let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
            await store.storeTranscript(
                sessionKey: "main",
                messages: [cacheMessage(role: "user", text: "old-schema", timestamp: 1)])
            await store.retire()
        }

        var raw: OpaquePointer?
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(raw, "DROP TABLE outbox_commands", nil, nil, nil) == SQLITE_OK)
        #expect(sqlite3_exec(raw, "PRAGMA user_version = 1", nil, nil, nil) == SQLITE_OK)
        sqlite3_close_v2(raw)

        let migrated = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await messageTexts(migrated.loadTranscript(sessionKey: "main")) == ["old-schema"])
        #expect(await migrated.enqueueCommand(outboxCommand(id: "c-1", text: "preserved migration")))
        #expect(await migrated.loadCommands().map(\.text) == ["preserved migration"])
    }

    @Test func `unknown schema preserves durable outbox bytes and fails closed`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        do {
            let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
            #expect(await store.enqueueCommand(outboxCommand(id: "c-1", text: "do not delete")))
            await store.retire()
        }

        var raw: OpaquePointer?
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(raw, "PRAGMA user_version = 99", nil, nil, nil) == SQLITE_OK)
        sqlite3_close_v2(raw)

        let blocked = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await blocked.loadCommands().isEmpty)
        #expect(await !blocked.enqueueCommand(outboxCommand(id: "c-2", text: "must fail closed")))

        // Restore the known version to prove the blocked open did not delete
        // or rebuild the persistent outbox table.
        raw = nil
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(raw, "PRAGMA user_version = 2", nil, nil, nil) == SQLITE_OK)
        sqlite3_close_v2(raw)
        let recovered = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await recovered.loadCommands().map(\.text) == ["do not delete"])
    }

    @Test func `corrupt existing database is preserved and fails closed`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let original = Data("this is not a sqlite database".utf8)
        try original.write(to: url)

        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await store.loadTranscript(sessionKey: "main").isEmpty)
        await store.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "recovered", timestamp: 1)])
        #expect(await store.loadTranscript(sessionKey: "main").isEmpty)
        #expect(try Data(contentsOf: url) == original)
    }

    @Test func `undecodable row is dropped and treated as miss`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        await store.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "seed", timestamp: 1)])

        var raw: OpaquePointer?
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "UPDATE cached_transcripts SET payload = '{not json' WHERE session_key = 'main'",
            nil,
            nil,
            nil) == SQLITE_OK)
        sqlite3_close_v2(raw)

        let reader = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await reader.loadTranscript(sessionKey: "main").isEmpty)
        // The bad row was deleted, not just skipped.
        #expect(await reader.loadTranscript(sessionKey: "main").isEmpty)
    }
}

struct ChatCommandOutboxStoreTests {
    @Test func `outbox commands round trip in createdAt order across store instances`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        // Recent timestamps: rows older than the staleness gate would expire.
        let now = Date().timeIntervalSince1970
        do {
            let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
            #expect(await store.enqueueCommand(
                outboxCommand(id: "c-2", text: "second", thinking: "high", createdAt: now - 10)))
            #expect(await store.enqueueCommand(
                outboxCommand(id: "c-1", text: "first", thinking: "off", createdAt: now - 20)))
        }

        // New instance = simulated app relaunch: rows are durable.
        let reopened = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let loaded = await reopened.loadCommands()
        #expect(loaded.map(\.id) == ["c-1", "c-2"])
        #expect(loaded.map(\.text) == ["first", "second"])
        #expect(loaded.map(\.thinking) == ["off", "high"])
        #expect(loaded.map(\.status) == [.queued, .queued])
        #expect(loaded.map(\.retryCount) == [0, 0])
        #expect(loaded.map(\.lastError) == [nil, nil])
        #expect(loaded.map(\.sessionKey) == ["main", "main"])
    }

    @Test func `claims are FIFO and exclusive until the sender advances`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let now = Date().timeIntervalSince1970
        #expect(await store.enqueueCommand(outboxCommand(id: "c-1", text: "first", createdAt: now)))
        #expect(await store.enqueueCommand(outboxCommand(id: "c-2", text: "second", createdAt: now + 1)))

        #expect(await store.claimNextCommand()?.id == "c-1")
        #expect(await store.claimNextCommand() == nil)
        #expect(await store.markCommandAwaitingConfirmation(id: "c-1") == .updated)
        #expect(await store.claimNextCommand()?.id == "c-2")
    }

    @Test func `user cancellation cannot delete a claimed command`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await store.enqueueCommand(outboxCommand(id: "c-1", text: "claimed")))
        #expect(await store.claimNextCommand()?.id == "c-1")

        #expect(await store.cancelCommand(id: "c-1") == .missing)
        #expect(await store.loadCommands().map(\.status) == [.sending])
        #expect(await store.confirmCommand(id: "c-1") == .updated)
        #expect(await store.loadCommands().isEmpty)
    }

    @Test func `queued cancellation atomically scrubs and suppresses its cached bubble`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await store.enqueueCommand(outboxCommand(id: "c-cancel", text: "cancel me")))
        let staleSnapshot = [
            cacheMessage(
                role: "user",
                text: "cancel me",
                timestamp: 1,
                idempotencyKey: "c-cancel:user"),
            cacheMessage(
                role: "assistant",
                text: "newer row",
                timestamp: 2,
                idempotencyKey: "other-run"),
        ]
        await store.storeTranscript(sessionKey: "main", messages: staleSnapshot)

        #expect(await store.cancelCommand(id: "c-cancel") == .updated)
        #expect(await messageTexts(store.loadTranscript(sessionKey: "main")) == ["newer row"])

        // An overlapping view can finish a stale whole-transcript write after
        // cancellation. The cache owner keeps the canceled UUID suppressed.
        await store.storeTranscript(sessionKey: "main", messages: staleSnapshot)
        #expect(await messageTexts(store.loadTranscript(sessionKey: "main")) == ["newer row"])

        // Canonical history can prove an ambiguous send really landed. That
        // authoritative row clears suppression and remains cacheable offline.
        await store.storeCanonicalTranscript(
            sessionKey: "main",
            messages: staleSnapshot,
            canonicalMessageIdempotencyKeys: ["c-cancel:user"])
        #expect(await messageTexts(store.loadTranscript(sessionKey: "main")) == ["cancel me", "newer row"])

        #expect(await store.enqueueCommand(outboxCommand(id: "c-canonical-first", text: "already landed")))
        let canonicalFirst = [cacheMessage(
            role: "user",
            text: "already landed",
            timestamp: 3,
            idempotencyKey: "c-canonical-first:user")]
        await store.storeCanonicalTranscript(
            sessionKey: "main",
            messages: canonicalFirst,
            canonicalMessageIdempotencyKeys: ["c-canonical-first:user"])
        #expect(await store.cancelCommand(id: "c-canonical-first") == .confirmed)
        #expect(await messageTexts(store.loadTranscript(sessionKey: "main")) == ["already landed"])
    }

    @Test func `cancellation lookup failure preserves the queued command`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await store.enqueueCommand(outboxCommand(id: "c-lookup", text: "keep me")))

        var raw: OpaquePointer?
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "ALTER TABLE outbox_commands RENAME TO outbox_commands_unavailable",
            nil,
            nil,
            nil) == SQLITE_OK)
        sqlite3_close_v2(raw)

        #expect(await store.cancelCommand(id: "c-lookup") == .unavailable)

        raw = nil
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "ALTER TABLE outbox_commands_unavailable RENAME TO outbox_commands",
            nil,
            nil,
            nil) == SQLITE_OK)
        sqlite3_close_v2(raw)
        #expect(await store.loadCommands().map(\.id) == ["c-lookup"])
    }

    @Test func `transcript lookup failure rolls back queued cancellation`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await store.enqueueCommand(outboxCommand(id: "c-cache", text: "keep me")))
        await store.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(
                role: "user",
                text: "keep me",
                timestamp: 1,
                idempotencyKey: "c-cache:user")])

        var raw: OpaquePointer?
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "ALTER TABLE cached_transcripts RENAME TO cached_transcripts_unavailable",
            nil,
            nil,
            nil) == SQLITE_OK)
        sqlite3_close_v2(raw)

        #expect(await store.cancelCommand(id: "c-cache") == .unavailable)
        #expect(await store.loadCommands().map(\.id) == ["c-cache"])
    }

    @Test func `interrupted sending rows revert to queued on recovery`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        do {
            let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
            #expect(await store.enqueueCommand(outboxCommand(id: "c-1", text: "in flight")))
            #expect(await store.claimNextCommand()?.id == "c-1")
            #expect(await store.loadCommands().map(\.status) == [.sending])
        }

        // Simulated crash mid-send: a fresh process recovers the row to
        // queued; the idempotency key makes the re-send safe.
        let reopened = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await reopened.recoverInterruptedSends())
        #expect(await reopened.loadCommands().map(\.status) == [.queued])

        // An unreachable store must report failure so callers do not burn
        // their once-per-launch recovery gate while the DB is locked.
        await reopened.retire()
        #expect(await !reopened.recoverInterruptedSends())
    }

    @Test func `queued commands expire to failed at the staleness boundary`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let now = Date().timeIntervalSince1970
        let maxAge = OpenClawChatSQLiteTranscriptCache.outboxCommandMaxAge
        #expect(await store.enqueueCommand(
            outboxCommand(id: "c-stale", text: "stale", createdAt: now - maxAge - 60)))
        #expect(await store.enqueueCommand(
            outboxCommand(id: "c-fresh", text: "fresh", createdAt: now - maxAge + 60)))
        #expect(await store.enqueueCommand(
            OpenClawChatOutboxCommand(
                id: "c-unconfirmed",
                sessionKey: "main",
                text: "unconfirmed",
                thinking: "off",
                createdAt: now - maxAge - 60,
                status: .sending,
                retryCount: 0,
                lastError: nil)))
        #expect(await store.markCommandAwaitingConfirmation(id: "c-unconfirmed") == .updated)

        let loaded = await store.loadCommands()
        let stale = try #require(loaded.first { $0.id == "c-stale" })
        let fresh = try #require(loaded.first { $0.id == "c-fresh" })
        let unconfirmed = try #require(loaded.first { $0.id == "c-unconfirmed" })
        #expect(stale.status == .failed)
        #expect(stale.lastError == OpenClawChatSQLiteTranscriptCache.outboxExpiredError)
        #expect(fresh.status == .queued)
        #expect(fresh.lastError == nil)
        #expect(unconfirmed.status == .failed)
        #expect(unconfirmed.lastError == OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError)
    }

    @Test func `enqueue refuses beyond the queue bound`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let bound = OpenClawChatSQLiteTranscriptCache.maxQueuedCommands

        for index in 0..<bound {
            #expect(await store.enqueueCommand(outboxCommand(id: "c-\(index)", text: "m\(index)")))
        }
        #expect(await !store.enqueueCommand(outboxCommand(id: "c-overflow", text: "one too many")))
        #expect(await store.loadCommands().count == bound)

        // Deleting a row frees capacity again.
        #expect(await store.cancelCommand(id: "c-0") == .updated)
        #expect(await store.enqueueCommand(outboxCommand(id: "c-after-delete", text: "fits now")))
    }

    @Test func `outbox rows are scoped per gateway identity`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let storeA = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let storeB = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-b")

        #expect(await storeA.enqueueCommand(outboxCommand(id: "c-a", text: "for gateway A")))
        #expect(await storeB.loadCommands().isEmpty)

        // Cross-gateway mutations must not leak either.
        await storeB.markCommandFailed(id: "c-a", retryCount: 3, lastError: "boom")
        #expect(await storeB.cancelCommand(id: "c-a") == .missing)
        let survivors = await storeA.loadCommands()
        #expect(survivors.map(\.id) == ["c-a"])
        #expect(survivors.map(\.status) == [.queued])
    }

    @Test func `retry and failure marks persist retry count and last error`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await store.enqueueCommand(outboxCommand(id: "c-1", text: "retry me")))

        await store.markCommandQueued(id: "c-1", retryCount: 2, lastError: "socket closed")
        var loaded = await store.loadCommands()
        #expect(loaded.map(\.status) == [.queued])
        #expect(loaded.map(\.retryCount) == [2])
        #expect(loaded.map(\.lastError) == ["socket closed"])

        await store.markCommandFailed(id: "c-1", retryCount: 3, lastError: "gave up")
        loaded = await store.loadCommands()
        #expect(loaded.map(\.status) == [.failed])
        #expect(loaded.map(\.retryCount) == [3])
        #expect(loaded.map(\.lastError) == ["gave up"])

        #expect(await store.cancelCommand(id: "c-1") == .updated)
        #expect(await store.loadCommands().isEmpty)
    }
}
