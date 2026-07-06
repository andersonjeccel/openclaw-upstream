import Foundation
import OpenClawKit
import OSLog

private let outboxLogger = Logger(subsystem: "ai.openclaw", category: "OpenClawChatOutbox")

/// Display state for a transcript row backed by a durable outbox command.
public enum OpenClawChatOutboxMessageState: Equatable, Sendable {
    case queued
    case sending
    case confirming
    case failed(reason: String?)

    public var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }

    var preventsDeletion: Bool {
        self == .sending || self == .confirming
    }
}

// Durable offline command outbox. Sends made while the gateway is unhealthy
// are persisted (per gateway, alongside the transcript cache) and flushed
// strictly in createdAt order when health recovers. A gateway ACK only moves
// a row to awaiting-confirmation; canonical history owns durable completion.
extension OpenClawChatViewModel {
    public func outboxState(for messageID: UUID) -> OpenClawChatOutboxMessageState? {
        self.outboxStatesByMessageID[messageID]
    }

    /// Tap-to-retry for a failed command: reset attempts, refresh createdAt
    /// (so even an expired row can send again), and flush if healthy.
    public func retryOutboxMessage(_ messageID: UUID) {
        guard let outbox, let commandID = self.outboxCommandIDsByMessageID[messageID] else { return }
        self.outboxStatesByMessageID[messageID] = .queued
        Task { [weak self] in
            await outbox.markCommandRetried(id: commandID)
            self?.flushOutboxIfNeeded()
        }
    }

    public func deleteOutboxMessage(_ messageID: UUID) {
        guard let outbox, let commandID = self.outboxCommandIDsByMessageID[messageID] else { return }
        // Tombstone first, synchronously: an active flush checks this set
        // right before its transport call, so the deleted command cannot be
        // sent even if the row deletion below races the flush's claim.
        self.deletedOutboxCommandIDs.insert(commandID)
        Task { [weak self] in
            // Durable delete before the bubble disappears: if the process
            // dies in this window, both the row and the visible bubble
            // survive, so a user-deleted command can never silently
            // resurrect and send on the next launch.
            await outbox.deleteCommand(id: commandID)
            guard let self else { return }
            // Row is durably gone; the tombstone has done its job.
            self.deletedOutboxCommandIDs.remove(commandID)
            self.outboxCommandIDsByMessageID.removeValue(forKey: messageID)
            self.outboxMessageIDsByCommandID.removeValue(forKey: commandID)
            self.outboxStatesByMessageID.removeValue(forKey: messageID)
            self.replaceMessages(self.messages.filter { $0.id != messageID })
        }
    }

    // MARK: - Capture

    /// Offline capture path used by performSend when the gateway is
    /// unhealthy: persist first, then render the queued bubble. A full queue
    /// refuses the enqueue and keeps the draft so no text is lost.
    func enqueueOutboxCommand(text: String, session: SessionSnapshot) async {
        guard let outbox else { return }
        let command = OpenClawChatOutboxCommand(
            id: UUID().uuidString,
            sessionKey: session.key,
            text: text,
            thinking: self.thinkingLevel,
            createdAt: Date().timeIntervalSince1970,
            status: .queued,
            retryCount: 0,
            lastError: nil)
        let accepted = await outbox.enqueueCommand(command)
        guard self.isCurrentSession(session) else { return }
        guard accepted else {
            self.errorText = "Offline queue is full. Delete a queued message or reconnect to send."
            return
        }
        self.input = ""
        self.errorText = nil
        self.presentOutboxCommands([command])
        // Health can recover between the send-gate check and the enqueue;
        // flushing here closes that gap instead of waiting for the next event.
        if self.healthOK {
            self.flushOutboxIfNeeded()
        }
    }

    /// Requeue path for a live text send that failed at the transport while
    /// `healthOK` was stale-true. Reuses the send's runId as the command ID so
    /// the optimistic bubble's "\(runId):user" key and the gateway's dedupe
    /// identity are preserved even if the failed send actually landed.
    /// Returns false when the queue refuses (caller keeps the failure path).
    func requeueFailedLiveSend(
        runId: String,
        text: String,
        thinking: String,
        messageID: UUID,
        session: SessionSnapshot) async -> Bool
    {
        guard let outbox else { return false }
        let command = OpenClawChatOutboxCommand(
            id: runId,
            sessionKey: session.key,
            text: text,
            thinking: thinking,
            createdAt: Date().timeIntervalSince1970,
            status: .queued,
            retryCount: 0,
            lastError: nil)
        guard await outbox.enqueueCommand(command) else { return false }
        guard self.isCurrentSession(session) else { return true }
        self.mapOutboxCommand(command, to: messageID)
        self.errorText = nil
        // Auto-retry immediately while health still reads healthy; either the
        // transport recovered or the command lands visibly in 'failed'.
        self.flushOutboxIfNeeded()
        return true
    }

    // MARK: - Restore

    /// Session switches drop the visible bubbles, so per-message outbox
    /// state must go with them, and the FIFO send gate must assume a backlog
    /// again until restore adopts the new session's durable rows. Without
    /// this reset a send issued right after a switch could go live ahead of
    /// that session's persisted queue.
    func resetOutboxPresentationForSessionSwitch() {
        self.hasRestoredOutboxMessages = false
        self.outboxCommandIDsByMessageID.removeAll()
        self.outboxMessageIDsByCommandID.removeAll()
        self.outboxStatesByMessageID.removeAll()
    }

    /// Re-adopts or re-appends queued bubbles for the visible session after
    /// cold open, session switches, and wholesale history replacement.
    func restoreOutboxMessages(session: SessionSnapshot) {
        guard let outbox else { return }
        Task { [weak self] in
            guard let self else { return }
            await self.recoverInterruptedOutboxSendsIfNeeded()
            let commands = await outbox.loadCommands()
            guard self.isCurrentSession(session) else { return }
            self.presentOutboxCommands(commands.filter { $0.sessionKey == session.key })
            // The FIFO send gate assumes a backlog until this point.
            self.hasRestoredOutboxMessages = true
            // Relaunching while already healthy never sees an unhealthy ->
            // healthy transition, so kick the flush here as well.
            if self.healthOK, commands.contains(where: { $0.status == .queued }) {
                self.flushOutboxIfNeeded()
            }
        }
    }

    /// Canonical history is the durable acceptance boundary. Any matching
    /// outbox row—including a lost-ACK queued row—is now safe to remove
    /// without replaying the user turn.
    func confirmOutboxCommands(in messages: [OpenClawChatMessage], session: SessionSnapshot) {
        guard let outbox else { return }
        let confirmedKeys = Set(messages.compactMap { Self.normalizedIdempotencyKey($0.idempotencyKey) })
        guard !confirmedKeys.isEmpty else { return }
        Task { [weak self] in
            guard let self else { return }
            let commands = await outbox.loadCommands().filter { command in
                command.sessionKey == session.key && confirmedKeys.contains(Self.outboxUserIdempotencyKey(command.id))
            }
            for command in commands {
                await outbox.deleteCommand(id: command.id)
                self.clearOutboxState(forCommandID: command.id)
            }
        }
    }

    /// Appends bubbles for commands in the current session, adopting rows
    /// that already carry the command's user idempotency key (cache pre-paint
    /// or an earlier restore), and refreshes their display states.
    private func presentOutboxCommands(_ commands: [OpenClawChatOutboxCommand]) {
        self.pruneOutboxMappings()
        guard !commands.isEmpty else { return }
        var next = self.messages
        for command in commands.sorted(by: { $0.createdAt < $1.createdAt }) {
            // User-deleted commands awaiting durable removal must not be
            // re-presented or re-mapped by a concurrent restore/flush pass.
            if self.deletedOutboxCommandIDs.contains(command.id) { continue }
            let key = Self.outboxUserIdempotencyKey(command.id)
            if let existing = next.first(where: { $0.idempotencyKey == key }) {
                self.mapOutboxCommand(command, to: existing.id)
                continue
            }
            let message = Self.outboxUserMessage(for: command)
            next.append(message)
            self.mapOutboxCommand(command, to: message.id)
        }
        self.replaceMessages(next)
    }

    private static func outboxUserMessage(for command: OpenClawChatOutboxCommand) -> OpenClawChatMessage {
        OpenClawChatMessage(
            role: "user",
            content: [
                OpenClawChatMessageContent(
                    type: "text",
                    text: command.text,
                    mimeType: nil,
                    fileName: nil,
                    content: nil),
            ],
            // Message timestamps are milliseconds; outbox rows store seconds.
            timestamp: command.createdAt * 1000,
            idempotencyKey: self.outboxUserIdempotencyKey(command.id))
    }

    private func mapOutboxCommand(_ command: OpenClawChatOutboxCommand, to messageID: UUID) {
        self.outboxCommandIDsByMessageID[messageID] = command.id
        self.outboxMessageIDsByCommandID[command.id] = messageID
        self.outboxStatesByMessageID[messageID] = Self.outboxDisplayState(for: command)
    }

    private func pruneOutboxMappings() {
        let visibleMessageIDs = Set(self.messages.map(\.id))
        let staleMessageIDs = self.outboxCommandIDsByMessageID.keys.filter {
            !visibleMessageIDs.contains($0)
        }
        for messageID in staleMessageIDs {
            if let commandID = self.outboxCommandIDsByMessageID.removeValue(forKey: messageID) {
                self.outboxMessageIDsByCommandID.removeValue(forKey: commandID)
            }
            self.outboxStatesByMessageID.removeValue(forKey: messageID)
        }
    }

    // MARK: - Health

    func pollHealthIfNeeded(force: Bool, sessionSnapshot: SessionSnapshot? = nil) async {
        if !force, let last = lastHealthPollAt, Date().timeIntervalSince(last) < 10 {
            return
        }
        self.lastHealthPollAt = Date()
        do {
            let ok = try await self.transport.requestHealth(timeoutMs: 5000)
            if let sessionSnapshot, !self.isCurrentSession(sessionSnapshot) { return }
            self.applyTransportHealth(ok)
        } catch {
            if let sessionSnapshot, !self.isCurrentSession(sessionSnapshot) { return }
            self.applyTransportHealth(false)
        }
    }

    /// Single choke point for health updates so the offline outbox flushes
    /// exactly on the unhealthy -> healthy transition.
    func applyTransportHealth(_ ok: Bool) {
        let wasHealthy = self.healthOK
        self.healthOK = ok
        if ok, !wasHealthy {
            self.flushOutboxIfNeeded()
        }
    }

    // MARK: - Flush

    func flushOutboxIfNeeded() {
        guard self.outbox != nil, self.healthOK else { return }
        guard !self.isFlushingOutbox else {
            // Coalesce triggers that land mid-pass (tap-to-retry, enqueue
            // race) so their commands are not stranded until the next
            // health transition.
            self.isOutboxFlushRequestedWhileActive = true
            return
        }
        self.isFlushingOutbox = true
        Task { [weak self] in
            await self?.performOutboxFlush()
            guard let self else { return }
            self.isFlushingOutbox = false
            if self.isOutboxFlushRequestedWhileActive {
                self.isOutboxFlushRequestedWhileActive = false
                self.flushOutboxIfNeeded()
            }
        }
    }

    private func performOutboxFlush() async {
        guard let outbox else { return }
        await self.recoverInterruptedOutboxSendsIfNeeded()
        var flushedCurrentSession = false
        while self.healthOK {
            let commands = await outbox.loadCommands()
            self.presentOutboxCommands(commands.filter { $0.sessionKey == self.sessionKey })
            guard let next = await outbox.claimNextCommand() else { break }
            // Same ordering contract as the live send path: a run must not
            // start on a stale model while a sessions.patch(model) for its
            // session is still in flight.
            await self.waitForPendingModelPatches(in: next.sessionKey)
            // Delete may race the atomic claim while it is awaiting the store.
            // Delete durably before continuing so younger rows cannot strand
            // behind a sending tombstone.
            if self.deletedOutboxCommandIDs.contains(next.id) {
                await outbox.deleteCommand(id: next.id)
                self.deletedOutboxCommandIDs.remove(next.id)
                self.clearOutboxState(forCommandID: next.id)
                continue
            }
            self.setOutboxState(.sending, forCommandID: next.id)
            do {
                let response = try await self.transport.sendMessage(
                    sessionKey: next.sessionKey,
                    message: next.text,
                    // Thinking level captured at enqueue time, never the
                    // visible session's current setting.
                    thinking: next.thinking,
                    idempotencyKey: next.id,
                    attachments: [])
                if response.status == "error" || response.status == "timeout" {
                    // Gateway rejected the run: this burns a retry attempt,
                    // unlike transport-level failures handled in catch.
                    let handled = await self.recordOutboxRejection(
                        of: next,
                        outbox: outbox,
                        reason: "Run failed to start (\(response.status)).")
                    if handled { continue } else { break }
                }
                // Deliberately no pendingRuns adoption for background flushes:
                // the reply still lands via handleChatEvent's external-run
                // final branch (session-scoped, run-id independent),
                // handleSessionMessageEvent, and the post-drain history
                // refresh below. Run tracking (typing indicator, streaming,
                // timeouts) stays owned by interactive performSend.
                // chat.send ACK precedes durable user-turn persistence. Keep
                // the outbox row until history carries its idempotency key;
                // the cache splice makes the acknowledged turn visible while
                // canonical history catches up.
                await self.pendingCacheWriteTask?.value
                await self.spliceSentCommandIntoCachedTranscript(next)
                let confirmationUpdate = await outbox.markCommandAwaitingConfirmation(id: next.id)
                if confirmationUpdate == .unavailable {
                    self.applyTransportHealth(false)
                    break
                }
                if confirmationUpdate == .updated {
                    self.setOutboxState(.confirming, forCommandID: next.id)
                } else {
                    // A concurrent canonical history/session.message
                    // confirmation already removed the row.
                    self.clearOutboxState(forCommandID: next.id)
                }
                self.outboxTransportFailureStreak = 0
                if next.sessionKey == self.sessionKey {
                    flushedCurrentSession = true
                }
            } catch let error as GatewayResponseError {
                // A response error proves the gateway rejected the request;
                // unlike a socket/timeout failure, replay cannot duplicate an
                // accepted run and should consume the normal retry budget.
                let handled = await self.recordOutboxRejection(
                    of: next,
                    outbox: outbox,
                    reason: error.localizedDescription)
                if handled { continue } else { break }
            } catch {
                // Transport-level failure (unreachable, socket drop): a
                // connectivity blip, not a gateway verdict on the command.
                // Keep the row queued without burning a durable retry
                // attempt; the in-memory streak paces repeated throws up the
                // delay ladder instead of hammering the first rung forever.
                outboxLogger.error("outbox flush send failed \(error.localizedDescription, privacy: .public)")
                await outbox.markCommandQueued(
                    id: next.id,
                    retryCount: next.retryCount,
                    lastError: error.localizedDescription)
                self.setOutboxState(.queued, forCommandID: next.id)
                self.outboxTransportFailureStreak += 1
                if self.outboxTransportFailureStreak > self.outboxRetryDelaysMs.count {
                    // Ladder exhausted: the transport is not actually usable
                    // despite healthOK. Drop health so the reconnect/poll
                    // machinery owns pacing; the next genuine healthy
                    // transition re-flushes and the row stays queued.
                    self.healthOK = false
                    break
                }
                // Strict createdAt ordering: never skip ahead of a command
                // that is still deliverable.
                self.scheduleOutboxRetry(afterAttempts: self.outboxTransportFailureStreak)
                break
            }
        }
        // Tombstones are NOT cleared here: each lives until its delete task
        // confirms the row is durably gone (process death in that window
        // leaves both row and tombstone-protected bubble intact). The set
        // stays bounded by in-flight user deletes.
        if flushedCurrentSession {
            await self.refreshHistoryAfterOutboxFlush()
        }
    }

    /// Gateway rejections ("error"/"timeout" send acks) burn a retry attempt
    /// and become terminally 'failed' after `maxOutboxSendAttempts`. Returns
    /// true when the flush pass may continue with younger commands.
    private func recordOutboxRejection(
        of command: OpenClawChatOutboxCommand,
        outbox: any OpenClawChatCommandOutbox,
        reason: String) async -> Bool
    {
        outboxLogger.error("outbox flush send rejected \(reason, privacy: .public)")
        let attempts = command.retryCount + 1
        if attempts >= Self.maxOutboxSendAttempts {
            await outbox.markCommandFailed(id: command.id, retryCount: attempts, lastError: reason)
            self.setOutboxState(.failed(reason: reason), forCommandID: command.id)
            // Terminal failure needs user action; let younger commands
            // flush instead of blocking behind it forever.
            return true
        }
        await outbox.markCommandQueued(id: command.id, retryCount: attempts, lastError: reason)
        self.setOutboxState(.queued, forCommandID: command.id)
        // Strict createdAt ordering: never skip ahead of a command that
        // still has retries left.
        self.scheduleOutboxRetry(afterAttempts: attempts)
        return false
    }

    private func scheduleOutboxRetry(afterAttempts attempts: Int) {
        let delays = self.outboxRetryDelaysMs
        guard !delays.isEmpty else {
            self.outboxRetryTask?.cancel()
            self.outboxRetryTask = Task { [weak self] in
                await Task.yield()
                self?.flushOutboxIfNeeded()
            }
            return
        }
        let delayMs = delays[min(max(attempts - 1, 0), delays.count - 1)]
        self.outboxRetryTask?.cancel()
        self.outboxRetryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delayMs * 1_000_000)
            guard !Task.isCancelled else { return }
            self?.flushOutboxIfNeeded()
        }
    }

    /// Appends a flushed background-session turn to that session's cached
    /// transcript so a cold offline reopen shows it before live history.
    private func spliceSentCommandIntoCachedTranscript(_ command: OpenClawChatOutboxCommand) async {
        guard let transcriptCache else { return }
        let key = Self.outboxUserIdempotencyKey(command.id)
        var cached = await transcriptCache.loadTranscript(sessionKey: command.sessionKey)
        guard !cached.contains(where: { $0.idempotencyKey == key }) else { return }
        cached.append(Self.outboxUserMessage(for: command))
        await transcriptCache.storeTranscript(sessionKey: command.sessionKey, messages: cached)
    }

    private func recoverInterruptedOutboxSendsIfNeeded() async {
        guard let outbox else { return }
        // The store owns the once-per-process gate so overlapping/replacement
        // view models cannot reset another active sender's claim.
        _ = await outbox.recoverInterruptedSends()
    }

    private func setOutboxState(_ state: OpenClawChatOutboxMessageState, forCommandID commandID: String) {
        guard let messageID = self.outboxMessageIDsByCommandID[commandID] else { return }
        self.outboxStatesByMessageID[messageID] = state
    }

    private func clearOutboxState(forCommandID commandID: String) {
        guard let messageID = self.outboxMessageIDsByCommandID.removeValue(forKey: commandID) else { return }
        self.outboxCommandIDsByMessageID.removeValue(forKey: messageID)
        self.outboxStatesByMessageID.removeValue(forKey: messageID)
    }

    private static func outboxDisplayState(for command: OpenClawChatOutboxCommand)
        -> OpenClawChatOutboxMessageState
    {
        switch command.status {
        case .queued:
            .queued
        case .sending:
            .sending
        case .awaitingConfirmation:
            .confirming
        case .failed:
            .failed(reason: command.lastError)
        }
    }

    /// Matches the optimistic-send convention (`"<runId>:user"`), which is
    /// also the key the gateway persists on the durable user row.
    static func outboxUserIdempotencyKey(_ commandID: String) -> String {
        "\(commandID):user"
    }
}
