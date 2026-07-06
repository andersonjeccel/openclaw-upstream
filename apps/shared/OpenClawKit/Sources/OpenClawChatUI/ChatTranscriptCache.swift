import Foundation
import OSLog
import SQLite3
#if os(iOS)
import UIKit
#endif

private let cacheLogger = Logger(subsystem: "ai.openclaw", category: "OpenClawChatTranscriptCache")

/// Read-only offline cache seam for chat sessions and transcripts.
///
/// The cache only pre-paints cold opens and covers offline browsing; connected
/// reads always come from the gateway and replace cached content wholesale.
/// Implementations must scope all rows to a single gateway identity so
/// transcripts never leak across paired gateways.
public protocol OpenClawChatTranscriptCache: Sendable {
    func loadSessions() async -> [OpenClawChatSessionEntry]
    func loadTranscript(sessionKey: String) async -> [OpenClawChatMessage]
    func storeSessions(_ sessions: [OpenClawChatSessionEntry]) async
    func storeTranscript(sessionKey: String, messages: [OpenClawChatMessage]) async
}

/// One durable queued chat command (text only in v1). `id` is the client UUID
/// that becomes the transport idempotency key on flush, so at-least-once
/// delivery stays safe across retries and app restarts.
///
/// Naming mirrors the watch-side `QueuedCommand` shape (WatchChatCoordinator)
/// so the two queues can merge into one owner later.
public struct OpenClawChatOutboxCommand: Hashable, Sendable, Identifiable {
    public enum Status: String, Sendable {
        case queued
        case sending
        case awaitingConfirmation = "awaiting_confirmation"
        case failed
    }

    public let id: String
    public let sessionKey: String
    public let text: String
    /// Thinking level captured when the command was queued, so a later flush
    /// never borrows the setting of whichever session is visible then.
    public let thinking: String
    /// Seconds since 1970; flush order is strictly ascending `createdAt`.
    public let createdAt: Double
    public var status: Status
    public var retryCount: Int
    public var lastError: String?

    public init(
        id: String,
        sessionKey: String,
        text: String,
        thinking: String,
        createdAt: Double,
        status: Status,
        retryCount: Int,
        lastError: String?)
    {
        self.id = id
        self.sessionKey = sessionKey
        self.text = text
        self.thinking = thinking
        self.createdAt = createdAt
        self.status = status
        self.retryCount = retryCount
        self.lastError = lastError
    }
}

public enum OpenClawChatOutboxUpdateResult: Equatable, Sendable {
    case updated
    case missing
    case unavailable
}

/// Durable offline outbox for chat commands, scoped to one gateway identity
/// exactly like the transcript cache. Implementations persist queued sends so
/// they survive app restarts and flush on reconnect.
public protocol OpenClawChatCommandOutbox: Sendable {
    /// Returns false when the queue is full (`maxQueuedCommands`) or storage
    /// is unavailable; callers surface that instead of dropping text silently.
    func enqueueCommand(_ command: OpenClawChatOutboxCommand) async -> Bool
    /// Gateway-scoped rows in `createdAt` order. Applies the staleness gate:
    /// old queued or unconfirmed rows become failed so reconnect never sends
    /// stale or ambiguously delivered commands silently.
    func loadCommands() async -> [OpenClawChatOutboxCommand]
    /// Crash safety: rows stuck in 'sending' from a previous process revert
    /// to 'queued' once per store lifetime; acknowledged rows stay awaiting
    /// canonical history confirmation and are never replayed automatically.
    /// Returns false while storage is unavailable so callers can retry later.
    @discardableResult
    func recoverInterruptedSends() async -> Bool
    /// Atomically claims the oldest queued row when no other row is sending.
    /// Nil means another flusher owns the queue or no deliverable row remains.
    func claimNextCommand() async -> OpenClawChatOutboxCommand?
    func markCommandQueued(id: String, retryCount: Int, lastError: String?) async
    func markCommandAwaitingConfirmation(id: String) async -> OpenClawChatOutboxUpdateResult
    func markCommandFailed(id: String, retryCount: Int, lastError: String?) async
    /// Explicit user retry: reset attempts and refresh `createdAt` so an
    /// expired row can send again (retry is new intent, so it also moves the
    /// command to the queue tail rather than replaying its old position).
    func markCommandRetried(id: String) async
    func deleteCommand(id: String) async
}

/// SQLite-backed transcript cache for one gateway identity. Owners should use
/// one database file per gateway so reset can physically remove that gateway's
/// cached transcript bytes without disturbing other paired gateways; queries
/// are additionally scoped by `gatewayID` as a defensive belt.
///
/// Transcript rows are disposable, but the command outbox is persistent user
/// state. Schema upgrades migrate the shared database; unknown or corrupt
/// existing schemas fail closed without deleting queued commands.
public actor OpenClawChatSQLiteTranscriptCache: OpenClawChatTranscriptCache, OpenClawChatCommandOutbox {
    /// Bounds keep the cache small: enough for a recently-used session picker
    /// and a full first screen of transcript, not a durable archive.
    public static let maxCachedSessions = 50
    public static let maxCachedTranscripts = 50
    public static let maxCachedMessagesPerSession = 200
    /// Outbox bounds: refuse enqueue beyond this many rows per gateway, and
    /// expire queued commands instead of sending them after two days offline.
    public static let maxQueuedCommands = 50
    public static let outboxCommandMaxAge: TimeInterval = 48 * 60 * 60
    /// Machine-readable `lastError` set by the staleness gate.
    public static let outboxExpiredError = "expired"
    public static let outboxUnconfirmedError = "delivery_unconfirmed"
    // v2 adds the durable outbox to the disposable v1 transcript cache.
    static let schemaVersion: Int32 = 2
    private static let createOutboxTableSQL = """
    CREATE TABLE IF NOT EXISTS outbox_commands(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_uuid TEXT NOT NULL UNIQUE,
        gateway_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        text TEXT NOT NULL,
        thinking TEXT NOT NULL DEFAULT '',
        created_at REAL NOT NULL,
        status TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT ''
    )
    """

    /// Owns the raw sqlite handle so it closes on release without needing an
    /// isolated actor deinit (OpaquePointer is not Sendable).
    private final class Connection: @unchecked Sendable {
        let raw: OpaquePointer

        init(raw: OpaquePointer) {
            self.raw = raw
        }

        deinit {
            sqlite3_close_v2(self.raw)
        }
    }

    private let databaseURL: URL
    private let gatewayID: String
    private var db: Connection?
    private var isRetired = false
    private var hasRecoveredInterruptedSends = false
    /// Existing database failures preserve persistent outbox bytes and make
    /// this store a no-op; an explicit owner purge remains the recovery path.
    private var isBroken = false

    public init(databaseURL: URL, gatewayID: String) {
        self.databaseURL = databaseURL
        self.gatewayID = gatewayID
    }

    /// Startup-only cleanup, before any cache actor can own an open handle.
    public static func removeDatabaseFiles(at databaseURL: URL) {
        let fm = FileManager.default
        try? fm.removeItem(at: databaseURL)
        for suffix in ["-wal", "-shm", "-journal"] {
            try? fm.removeItem(at: URL(fileURLWithPath: databaseURL.path + suffix))
        }
    }

    // MARK: - OpenClawChatTranscriptCache

    public func loadSessions() async -> [OpenClawChatSessionEntry] {
        guard !self.isRetired else { return [] }
        guard let db = await self.handle() else { return [] }
        guard let payload = self.selectPayload(
            db,
            sql: "SELECT payload FROM cached_sessions WHERE gateway_id = ?1",
            bindings: [self.gatewayID])
        else {
            return []
        }
        guard let decoded = try? JSONDecoder().decode(
            [OpenClawChatSessionEntry].self,
            from: Data(payload.utf8))
        else {
            // Decode mismatch means a stale/foreign shape: drop the row silently.
            self.execute(db, sql: "DELETE FROM cached_sessions WHERE gateway_id = ?1", bindings: [self.gatewayID])
            return []
        }
        return decoded
    }

    public func loadTranscript(sessionKey: String) async -> [OpenClawChatMessage] {
        guard !self.isRetired else { return [] }
        guard let db = await self.handle() else { return [] }
        guard let payload = self.selectPayload(
            db,
            sql: "SELECT payload FROM cached_transcripts WHERE gateway_id = ?1 AND session_key = ?2",
            bindings: [self.gatewayID, sessionKey])
        else {
            return []
        }
        guard let decoded = try? JSONDecoder().decode(
            [OpenClawChatMessage].self,
            from: Data(payload.utf8))
        else {
            self.execute(
                db,
                sql: "DELETE FROM cached_transcripts WHERE gateway_id = ?1 AND session_key = ?2",
                bindings: [self.gatewayID, sessionKey])
            return []
        }
        return decoded
    }

    public func storeSessions(_ sessions: [OpenClawChatSessionEntry]) async {
        guard !self.isRetired else { return }
        guard let db = await self.handle() else { return }
        let bounded = Self.boundedSessions(sessions)
        guard !bounded.isEmpty else {
            self.execute(db, sql: "DELETE FROM cached_sessions WHERE gateway_id = ?1", bindings: [self.gatewayID])
            return
        }
        guard let payload = Self.encodeJSON(bounded) else { return }
        self.execute(
            db,
            sql: """
            INSERT OR REPLACE INTO cached_sessions(gateway_id, payload, updated_at)
            VALUES (?1, ?2, ?3)
            """,
            bindings: [self.gatewayID, payload, Date().timeIntervalSince1970])
    }

    public func storeTranscript(sessionKey: String, messages: [OpenClawChatMessage]) async {
        guard !self.isRetired else { return }
        guard let db = await self.handle() else { return }
        let bounded = Self.cacheableMessages(messages)
        guard !bounded.isEmpty else {
            // An emptied live transcript must also empty the cache, or the next
            // cold open would ghost-paint messages the gateway no longer has.
            self.execute(
                db,
                sql: "DELETE FROM cached_transcripts WHERE gateway_id = ?1 AND session_key = ?2",
                bindings: [self.gatewayID, sessionKey])
            return
        }
        guard let payload = Self.encodeJSON(bounded) else { return }
        self.execute(
            db,
            sql: """
            INSERT OR REPLACE INTO cached_transcripts(gateway_id, session_key, payload, updated_at)
            VALUES (?1, ?2, ?3, ?4)
            """,
            bindings: [self.gatewayID, sessionKey, payload, Date().timeIntervalSince1970])
        // rowid tie-breaks equal timestamps: INSERT OR REPLACE mints a fresh
        // rowid, so the most recently written transcript always survives.
        self.execute(
            db,
            sql: """
            DELETE FROM cached_transcripts WHERE gateway_id = ?1 AND session_key NOT IN (
                SELECT session_key FROM cached_transcripts WHERE gateway_id = ?1
                ORDER BY updated_at DESC, rowid DESC LIMIT \(Self.maxCachedTranscripts)
            )
            """,
            bindings: [self.gatewayID])
    }

    public func retire() async {
        // A queued write then either finishes before retirement or becomes a
        // no-op. Closing the handle lets the owner delete the whole cache file.
        self.isRetired = true
        self.db = nil
    }

    // MARK: - OpenClawChatCommandOutbox

    public func enqueueCommand(_ command: OpenClawChatOutboxCommand) async -> Bool {
        guard !self.isRetired, let db = await self.handle() else { return false }
        let count = self.selectInt(
            db,
            sql: "SELECT COUNT(*) FROM outbox_commands WHERE gateway_id = ?1",
            bindings: [self.gatewayID]) ?? 0
        // Bound the queue per gateway across all statuses so failed rows also
        // count: the user must clear them before queueing more.
        guard count < Self.maxQueuedCommands else { return false }
        return self.execute(
            db,
            sql: """
            INSERT INTO outbox_commands(
                client_uuid, gateway_id, session_key, text, thinking, created_at, status, retry_count, last_error
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '')
            """,
            bindings: [
                command.id,
                self.gatewayID,
                command.sessionKey,
                command.text,
                command.thinking,
                command.createdAt,
                command.status.rawValue,
                command.retryCount,
            ])
    }

    public func loadCommands() async -> [OpenClawChatOutboxCommand] {
        guard !self.isRetired, let db = await self.handle() else { return [] }
        guard self.applyOutboxStaleness(db) else { return [] }
        return self.readCommands(db)
    }

    @discardableResult
    public func recoverInterruptedSends() async -> Bool {
        guard !self.isRetired else { return false }
        if self.hasRecoveredInterruptedSends { return true }
        guard let db = await self.handle() else { return false }
        let recovered = self.execute(
            db,
            sql: "UPDATE outbox_commands SET status = 'queued' WHERE gateway_id = ?1 AND status = 'sending'",
            bindings: [self.gatewayID])
        if recovered {
            self.hasRecoveredInterruptedSends = true
        }
        return recovered
    }

    public func claimNextCommand() async -> OpenClawChatOutboxCommand? {
        guard !self.isRetired, let db = await self.handle() else { return nil }
        guard self.execute(db, sql: "BEGIN IMMEDIATE", bindings: []) else { return nil }
        var committed = false
        defer {
            if !committed {
                _ = self.execute(db, sql: "ROLLBACK", bindings: [])
            }
        }
        guard self.applyOutboxStaleness(db) else { return nil }
        let hasActiveClaim = (self.selectInt(
            db,
            sql: "SELECT COUNT(*) FROM outbox_commands WHERE gateway_id = ?1 AND status = 'sending'",
            bindings: [self.gatewayID]) ?? 0) > 0
        guard !hasActiveClaim else {
            committed = self.execute(db, sql: "COMMIT", bindings: [])
            return nil
        }
        guard var next = self.readCommands(db).first(where: { $0.status == .queued }) else {
            committed = self.execute(db, sql: "COMMIT", bindings: [])
            return nil
        }
        let updated = self.execute(
            db,
            sql: """
            UPDATE outbox_commands SET status = 'sending'
            WHERE gateway_id = ?1 AND client_uuid = ?2 AND status = 'queued'
            """,
            bindings: [self.gatewayID, next.id]) && sqlite3_changes(db) > 0
        guard updated else { return nil }
        committed = self.execute(db, sql: "COMMIT", bindings: [])
        guard committed else { return nil }
        next.status = .sending
        return next
    }

    public func markCommandQueued(id: String, retryCount: Int, lastError: String?) async {
        await self.updateCommandStatus(id: id, status: "queued", retryCount: retryCount, lastError: lastError)
    }

    public func markCommandAwaitingConfirmation(id: String) async -> OpenClawChatOutboxUpdateResult {
        guard !self.isRetired, let db = await self.handle() else { return .unavailable }
        let updated = self.execute(
            db,
            sql: """
            UPDATE outbox_commands SET status = 'awaiting_confirmation', retry_count = 0, last_error = ''
            WHERE gateway_id = ?1 AND client_uuid = ?2 AND status = 'sending'
            """,
            bindings: [self.gatewayID, id])
        guard updated else { return .unavailable }
        return sqlite3_changes(db) > 0 ? .updated : .missing
    }

    public func markCommandFailed(id: String, retryCount: Int, lastError: String?) async {
        await self.updateCommandStatus(id: id, status: "failed", retryCount: retryCount, lastError: lastError)
    }

    public func markCommandRetried(id: String) async {
        guard !self.isRetired, let db = await self.handle() else { return }
        // Fresh createdAt: without it the staleness gate would immediately
        // re-expire a retried row that sat offline past the 48h bound.
        self.execute(
            db,
            sql: """
            UPDATE outbox_commands SET status = 'queued', retry_count = 0, last_error = '', created_at = ?3
            WHERE gateway_id = ?1 AND client_uuid = ?2
            """,
            bindings: [self.gatewayID, id, Date().timeIntervalSince1970])
    }

    public func deleteCommand(id: String) async {
        guard !self.isRetired, let db = await self.handle() else { return }
        self.execute(
            db,
            sql: "DELETE FROM outbox_commands WHERE gateway_id = ?1 AND client_uuid = ?2",
            bindings: [self.gatewayID, id])
    }

    private func updateCommandStatus(id: String, status: String, retryCount: Int, lastError: String?) async {
        guard !self.isRetired, let db = await self.handle() else { return }
        self.execute(
            db,
            sql: """
            UPDATE outbox_commands SET status = ?3, retry_count = ?4, last_error = ?5
            WHERE gateway_id = ?1 AND client_uuid = ?2
            """,
            bindings: [self.gatewayID, id, status, retryCount, lastError ?? ""])
    }

    private func applyOutboxStaleness(_ db: OpaquePointer) -> Bool {
        // Old queued work is no longer safe to send automatically. Likewise,
        // an acknowledged row that never appeared in canonical history needs
        // an explicit user decision rather than a potentially duplicate replay.
        return self.execute(
            db,
            sql: """
            UPDATE outbox_commands
            SET status = 'failed',
                last_error = CASE WHEN status = 'awaiting_confirmation' THEN ?4 ELSE ?3 END
            WHERE gateway_id = ?1
              AND status IN ('queued', 'awaiting_confirmation')
              AND created_at < ?2
            """,
            bindings: [
                self.gatewayID,
                Date().timeIntervalSince1970 - Self.outboxCommandMaxAge,
                Self.outboxExpiredError,
                Self.outboxUnconfirmedError,
            ])
    }

    // MARK: - Cached shapes

    /// Text rows only in v1: strip attachment/binary payloads and tool
    /// arguments so the cache never persists base64 blobs or large payloads.
    static func cacheableMessages(_ messages: [OpenClawChatMessage]) -> [OpenClawChatMessage] {
        messages.suffix(self.maxCachedMessagesPerSession).map { message in
            OpenClawChatMessage(
                id: message.id,
                role: message.role,
                content: message.content.map { item in
                    OpenClawChatMessageContent(
                        type: item.type,
                        text: item.text,
                        thinking: item.thinking,
                        thinkingSignature: nil,
                        mimeType: item.mimeType,
                        fileName: item.fileName,
                        content: nil,
                        id: item.id,
                        name: item.name,
                        arguments: nil)
                },
                timestamp: message.timestamp,
                idempotencyKey: message.idempotencyKey,
                toolCallId: message.toolCallId,
                toolName: message.toolName,
                usage: message.usage,
                stopReason: message.stopReason,
                errorMessage: message.errorMessage)
        }
    }

    static func boundedSessions(_ sessions: [OpenClawChatSessionEntry]) -> [OpenClawChatSessionEntry] {
        guard sessions.count > self.maxCachedSessions else { return sessions }
        return Array(
            sessions
                .sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
                .prefix(self.maxCachedSessions))
    }

    private static func encodeJSON(_ value: some Encodable) -> String? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return String(bytes: data, encoding: .utf8)
    }

    // MARK: - Connection lifecycle

    private func handle() async -> OpaquePointer? {
        guard !self.isRetired else { return nil }
        if let db { return db.raw }
        if self.isBroken { return nil }
        #if os(iOS)
        // Complete protection intentionally makes the cache unavailable while
        // locked. Treat that as a temporary miss, never as corruption.
        guard await self.isProtectedDataAvailable(), !self.isRetired else { return nil }
        #endif
        let databaseExisted = FileManager.default.fileExists(atPath: self.databaseURL.path)
        if let opened = self.openConnection() {
            self.db = Connection(raw: opened)
            return opened
        }
        #if os(iOS)
        guard await self.isProtectedDataAvailable(), !self.isRetired else { return nil }
        #endif
        if databaseExisted {
            // The shared file may contain unsent user text. Preserve it for a
            // future compatible build or explicit owner purge instead of
            // turning a cache repair into silent outbox data loss.
            cacheLogger.error("chat offline store unavailable; preserving existing database")
            self.isBroken = true
            return nil
        }
        // A failed first create cannot contain user state; remove the partial
        // file and retry once so transient bootstrap failures self-heal.
        self.removeDatabaseFiles()
        if let reopened = self.openConnection() {
            self.db = Connection(raw: reopened)
            return reopened
        }
        cacheLogger.error("chat transcript cache unavailable; continuing without offline cache")
        self.isBroken = true
        return nil
    }

    #if os(iOS)
    private func isProtectedDataAvailable() async -> Bool {
        await MainActor.run { UIApplication.shared.isProtectedDataAvailable }
    }
    #endif

    private func openConnection() -> OpaquePointer? {
        let fm = FileManager.default
        try? fm.createDirectory(
            at: self.databaseURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        var opened: OpaquePointer?
        var flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        #if os(iOS)
        // Apply Complete protection through the SQLite VFS so auxiliary files
        // receive the same class as the main transcript database.
        flags |= SQLITE_OPEN_FILEPROTECTION_COMPLETE
        #endif
        guard sqlite3_open_v2(self.databaseURL.path, &opened, flags, nil) == SQLITE_OK, let opened else {
            sqlite3_close_v2(opened)
            return nil
        }
        guard let version = self.readUserVersion(opened) else {
            sqlite3_close_v2(opened)
            return nil
        }
        if version == 0 {
            guard self.createSchema(opened) else {
                sqlite3_close_v2(opened)
                return nil
            }
        } else if version == 1 {
            guard self.migrateSchemaFromV1(opened) else {
                sqlite3_close_v2(opened)
                return nil
            }
        } else if version != Self.schemaVersion {
            // Unknown schemas may contain outbox rows from a newer build.
            // The caller preserves the file and fails closed.
            sqlite3_close_v2(opened)
            return nil
        }
        #if os(iOS)
        // Upgrade a database created by an older build to the stricter class.
        try? fm.setAttributes(
            [.protectionKey: FileProtectionType.complete],
            ofItemAtPath: self.databaseURL.path)
        #endif
        return opened
    }

    private func readUserVersion(_ db: OpaquePointer) -> Int32? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "PRAGMA user_version", -1, &statement, nil) == SQLITE_OK else {
            return nil
        }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
        return sqlite3_column_int(statement, 0)
    }

    private func createSchema(_ db: OpaquePointer) -> Bool {
        let statements = [
            """
            CREATE TABLE IF NOT EXISTS cached_sessions(
                gateway_id TEXT NOT NULL PRIMARY KEY,
                payload TEXT NOT NULL,
                updated_at REAL NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS cached_transcripts(
                gateway_id TEXT NOT NULL,
                session_key TEXT NOT NULL,
                payload TEXT NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY(gateway_id, session_key)
            )
            """,
            Self.createOutboxTableSQL,
            "PRAGMA user_version = \(Self.schemaVersion)",
        ]
        for sql in statements {
            guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { return false }
        }
        return true
    }

    private func migrateSchemaFromV1(_ db: OpaquePointer) -> Bool {
        guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return false }
        var committed = false
        defer {
            if !committed {
                sqlite3_exec(db, "ROLLBACK", nil, nil, nil)
            }
        }
        guard sqlite3_exec(db, Self.createOutboxTableSQL, nil, nil, nil) == SQLITE_OK,
              sqlite3_exec(db, "PRAGMA user_version = \(Self.schemaVersion)", nil, nil, nil) == SQLITE_OK,
              sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK
        else {
            return false
        }
        committed = true
        return true
    }

    // MARK: - Statement helpers

    @discardableResult
    private func execute(_ db: OpaquePointer, sql: String, bindings: [Any]) -> Bool {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            cacheLogger.error("cache statement prepare failed")
            return false
        }
        defer { sqlite3_finalize(statement) }
        guard self.bind(statement, bindings: bindings) else { return false }
        return sqlite3_step(statement) == SQLITE_DONE
    }

    private func selectInt(_ db: OpaquePointer, sql: String, bindings: [Any]) -> Int? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(statement) }
        guard self.bind(statement, bindings: bindings) else { return nil }
        guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
        return Int(sqlite3_column_int64(statement, 0))
    }

    private func readCommands(_ db: OpaquePointer) -> [OpenClawChatOutboxCommand] {
        var statement: OpaquePointer?
        let sql = """
        SELECT client_uuid, session_key, text, thinking, created_at, status, retry_count, last_error
        FROM outbox_commands WHERE gateway_id = ?1
        ORDER BY created_at ASC, id ASC
        """
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(statement) }
        guard self.bind(statement, bindings: [self.gatewayID]) else { return [] }

        var commands: [OpenClawChatOutboxCommand] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            guard let id = sqlite3_column_text(statement, 0),
                  let sessionKey = sqlite3_column_text(statement, 1),
                  let text = sqlite3_column_text(statement, 2)
            else { continue }
            let thinking = sqlite3_column_text(statement, 3).map { String(cString: $0) } ?? ""
            let statusRaw = sqlite3_column_text(statement, 5).map { String(cString: $0) } ?? ""
            let lastError = sqlite3_column_text(statement, 7).map { String(cString: $0) } ?? ""
            guard let status = OpenClawChatOutboxCommand.Status(rawValue: statusRaw) else {
                // Unknown persistent states need a migration, never an implicit replay.
                continue
            }
            commands.append(
                OpenClawChatOutboxCommand(
                    id: String(cString: id),
                    sessionKey: String(cString: sessionKey),
                    text: String(cString: text),
                    thinking: thinking,
                    createdAt: sqlite3_column_double(statement, 4),
                    status: status,
                    retryCount: Int(sqlite3_column_int64(statement, 6)),
                    lastError: lastError.isEmpty ? nil : lastError))
        }
        return commands
    }

    private func selectPayload(_ db: OpaquePointer, sql: String, bindings: [Any]) -> String? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(statement) }
        guard self.bind(statement, bindings: bindings) else { return nil }
        guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
        guard let text = sqlite3_column_text(statement, 0) else { return nil }
        return String(cString: text)
    }

    private func bind(_ statement: OpaquePointer?, bindings: [Any]) -> Bool {
        // SQLITE_TRANSIENT: sqlite copies the buffer before the Swift string dies.
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (offset, value) in bindings.enumerated() {
            let index = Int32(offset + 1)
            let result: Int32 = switch value {
            case let text as String:
                sqlite3_bind_text(statement, index, text, -1, transient)
            case let int as Int:
                sqlite3_bind_int64(statement, index, Int64(int))
            case let real as Double:
                sqlite3_bind_double(statement, index, real)
            default:
                SQLITE_MISUSE
            }
            guard result == SQLITE_OK else { return false }
        }
        return true
    }

    private func removeDatabaseFiles() {
        self.db = nil
        Self.removeDatabaseFiles(at: self.databaseURL)
    }
}
