import Foundation

/// The wording of the Codex reset forecast, and the opt-in notification built
/// on top of it.
///
/// Every string here is mirrored character for character in the wording section
/// of `src/reset-forecast.ts`, so `codeburn quota`, the quota hover card and the
/// Plan tab print the same sentence. Deliberately not `NumberFormatter` or
/// `RelativeDateTimeFormatter`: a locale-aware formatter would drift away from
/// the TypeScript side the first time anyone ran the app outside `en_US`.
///
/// The honesty rules are the reason this type exists at all:
/// - A probability is never rendered without its range.
/// - The word is "chance". Never "expected", never "will".
/// - The notification says it is a statistical estimate from public history and
///   not an announcement, and it does nothing but say that.
enum CodexResetForecastPresentation {

    // MARK: - Numbers

    static func percent(_ value: Double) -> String {
        "\(Int((CodexResetForecast.clamp01(value) * 100).rounded()))%"
    }

    /// "(10 to 51%)" — one sign, on the end, as in a spoken range.
    static func range(_ range: CodexResetForecast.ProbabilityRange) -> String {
        "(\(Int((CodexResetForecast.clamp01(range.low) * 100).rounded())) to \(percent(range.high)))"
    }

    /// "14:30" in the reader's own time zone. Used only to say when a reset
    /// this machine observed was seen, which is a wall-clock fact about this
    /// machine. Hand-formatted rather than `DateFormatter` so it comes out
    /// character-identical to the TypeScript side in every locale.
    static func localClock(_ at: Date) -> String {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: at)
        let hour = String(format: "%02d", parts.hour ?? 0)
        let minute = String(format: "%02d", parts.minute ?? 0)
        return "\(hour):\(minute)"
    }

    /// "45m", "12h", "2.2d". Compact on purpose: this sits inside a sentence.
    static func duration(hours: Double) -> String {
        guard hours.isFinite, hours >= 0 else { return "0m" }
        if hours < 1 { return "\(max(1, Int((hours * 60).rounded())))m" }
        if hours < 48 { return "\(Int(hours.rounded()))h" }
        return String(format: "%.1fd", ((hours / 24) * 10).rounded() / 10)
    }

    // MARK: - Sentences

    /// Line one is the sentence every surface prints; it always carries the
    /// range, and it says "chance". Line two is provenance and caveats, and
    /// deliberately carries no number that could be read as a probability.
    static func lines(for result: CodexResetForecast.Result) -> [String] {
        guard case let .available(reading) = result else {
            guard case let .unavailable(reason, _) = result else { return [] }
            return [L("Reset forecast: unavailable. %@", reason)]
        }
        let since = reading.lastResetSource == .local
            ? L("reset observed on this machine at %@", localClock(reading.lastResetAt))
            : L("last global reset")
        // Two whole sentences rather than one with a `yes`/`no` hole in it: a
        // translator needs the sentence, and "yes" on its own is not one.
        let template = reading.workingHoursSF
            ? "Reset forecast: %@ chance in the next 24h %@, %@ in 6h %@. %@ since the %@; typical wait %@. Working hours in SF: yes."
            : "Reset forecast: %@ chance in the next 24h %@, %@ in 6h %@. %@ since the %@; typical wait %@. Working hours in SF: no."
        let headline = L(
            template,
            percent(reading.within24h.point), range(reading.within24h),
            percent(reading.within6h.point), range(reading.within6h),
            duration(hours: reading.hoursSinceLastReset), since,
            duration(hours: reading.typicalWaitHours)
        )

        var caveats = [L("Estimated from %lld past resets in the public record", reading.resetCount)]
        if reading.beyondRecord { caveats.append(L("the wait is already longer than any in that record")) }
        if reading.stale {
            caveats.append(reading.datasetAgeDays.isFinite
                ? L("the record is %lld days old and out of date", Int(reading.datasetAgeDays.rounded(.down)))
                : L("the record carries no date and is out of date"))
        }
        // The full stop rides the last clause, so no bare "." key exists for a
        // translator to guess at.
        caveats.append(reading.confidence == .moderate ? L("moderate confidence.") : L("low confidence."))
        return [headline, caveats.joined(separator: "; ")]
    }

    /// Which copy of the record the forecast is reading, and when that copy was
    /// built. The instant is left in the record's own ISO form, unformatted and
    /// in UTC, so it matches the `Record:` line `codeburn quota` prints
    /// character for character and cannot drift with a locale.
    static func datasetLine(generatedAt: String?, source: CodexResetHistorySource) -> String {
        let origin = source == .fetched
            ? L("refreshed from this repository on GitHub")
            : L("bundled with this build")
        guard let generatedAt, !generatedAt.isEmpty else { return L("Record: %@.", origin) }
        return L("Record: %@, %@.", generatedAt, origin)
    }

    /// The notification. It says what it is before it says a number, and it
    /// never asks the reader to do anything: no action buttons, no deep link,
    /// nothing spent, nothing redeemed, nothing refreshed.
    static func notice(for reading: CodexResetForecast.Reading) -> (title: String, body: String) {
        let since = reading.lastResetSource == .local
            ? "reset observed on this machine at \(localClock(reading.lastResetAt))"
            : "last global reset"
        // One literal, not a `+` chain: the key is what the catalog is keyed by,
        // and the localization scanner reads the source rather than running it,
        // so a concatenated key is only half-visible to the tooling that is
        // supposed to prove every key is translated.
        // swiftlint:disable:next line_length
        let body = L("A statistical estimate from public reset history, not an announcement from OpenAI. %@ chance %@ of a Codex limit reset in the next 6h. %@ since the %@. Nothing has reset yet and nothing was changed.", percent(reading.within6h.point), range(reading.within6h), duration(hours: reading.hoursSinceLastReset), since)
        return (L("Codex reset forecast"), body)
    }
}

// MARK: - Preferences

/// Opt-in, and off by default. The other quota notices default on because they
/// report something that already happened; this one reports a probability, and
/// a probability that arrives uninvited is a worse trade.
enum CodexResetForecastNotificationPreference {
    static let defaultsKey = "codeburn.codex.resetForecastNotificationsEnabled"

    static func isEnabled(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: defaultsKey) as? Bool ?? false
    }
}

/// The chance of a reset inside six hours at which the notification fires.
enum CodexResetForecastThresholdPreference {
    static let defaultsKey = "codeburn.codex.resetForecastNotificationThreshold"
    static let defaultValue: Double = 0.5

    /// Choices offered in Settings, as fractions.
    static let choices: [Double] = [0.25, 0.4, 0.5, 0.6, 0.75, 0.9]

    static func value(defaults: UserDefaults = .standard) -> Double {
        guard let stored = defaults.object(forKey: defaultsKey) as? Double,
              stored.isFinite, stored > 0, stored <= 1
        else { return defaultValue }
        return stored
    }
}

// MARK: - Crossing detector

/// What the notification remembers between refreshes and across relaunches.
struct CodexResetForecastAlertState: Codable, Equatable, Sendable {
    /// False between firing and the probability falling back under the
    /// threshold. This is the whole anti-nagging mechanism.
    var armed: Bool = true
    /// The threshold the outstanding notice fired at. Kept so that moving the
    /// threshold re-arms: without it, lowering the threshold after a notice
    /// could never fire again.
    var firedAtThreshold: Double?
    /// The reset the outstanding notice was judged against. A new reset starts a
    /// new wait, and therefore a new crossing.
    var lastResetAt: Date?
    var lastFiredAt: Date?
}

/// Decides whether a reading crosses the user's threshold, and nothing else.
/// Pure: every clock value is passed in, so the hysteresis is testable without
/// a notification centre, a file or a running app.
enum CodexResetForecastCrossingDetector {
    struct Outcome: Equatable {
        let state: CodexResetForecastAlertState
        /// The reading to notify about, or nil for silence.
        let fire: CodexResetForecast.Reading?
    }

    static func evaluate(
        reading: CodexResetForecast.Reading?,
        state: CodexResetForecastAlertState,
        threshold: Double,
        now: Date
    ) -> Outcome {
        var next = state

        // No reading is no opinion: the state is left exactly as it was, so a
        // failed refresh cannot re-arm a notice that has already fired.
        guard let reading else { return Outcome(state: next, fire: nil) }

        // A new reset re-arms. The crossing that follows belongs to a new wait,
        // and the user has not been told about that one.
        if next.lastResetAt != reading.lastResetAt {
            next.armed = true
            next.firedAtThreshold = nil
            next.lastResetAt = reading.lastResetAt
        }
        // A changed threshold re-arms, for the same reason.
        if let fired = next.firedAtThreshold, fired != threshold {
            next.armed = true
            next.firedAtThreshold = nil
        }

        // An out-of-range threshold is a broken preference, not a reason to
        // notify at every refresh.
        guard threshold > 0, threshold <= 1 else { return Outcome(state: next, fire: nil) }
        // An out-of-date record is not worth waking anyone for, and neither is
        // an estimate whose wait is already off the end of the record: the
        // number there comes from a memoryless fallback with a 0-to-100% range.
        guard !reading.stale, !reading.beyondRecord else { return Outcome(state: next, fire: nil) }

        if reading.within6h.point < threshold {
            next.armed = true
            next.firedAtThreshold = nil
            return Outcome(state: next, fire: nil)
        }
        guard next.armed else { return Outcome(state: next, fire: nil) }
        next.armed = false
        next.firedAtThreshold = threshold
        next.lastFiredAt = now
        return Outcome(state: next, fire: reading)
    }
}

// MARK: - Persistence

protocol CodexResetForecastStateStoring: Sendable {
    func load() async -> CodexResetForecastAlertState
    func save(_ state: CodexResetForecastAlertState) async
}

private let resetForecastFilename = "codex-reset-forecast.json"

private func resetForecastPath() -> String {
    (CodeBurnCacheDirectory.resolve() as NSString).appendingPathComponent(resetForecastFilename)
}

private actor ResetForecastLock {
    static let shared = ResetForecastLock()
    func run<T>(_ fn: () throws -> T) rethrows -> T { try fn() }
}

/// Same shape as `SubscriptionSnapshotStore`: one JSON document in the CodeBurn
/// cache directory, serialized behind an actor, written 0600 through `SafeFile`
/// (which refuses a symlinked target and does the tmp+rename dance). Persisted
/// so a relaunch does not repeat a notice the user has already seen.
struct CodexResetForecastStore: CodexResetForecastStateStoring {
    func load() async -> CodexResetForecastAlertState {
        await ResetForecastLock.shared.run {
            let path = resetForecastPath()
            guard FileManager.default.fileExists(atPath: path),
                  let data = try? SafeFile.read(from: path) else { return CodexResetForecastAlertState() }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            return (try? decoder.decode(CodexResetForecastAlertState.self, from: data)) ?? CodexResetForecastAlertState()
        }
    }

    func save(_ state: CodexResetForecastAlertState) async {
        await ResetForecastLock.shared.run {
            do {
                let encoder = JSONEncoder()
                encoder.dateEncodingStrategy = .iso8601
                try SafeFile.write(encoder.encode(state), to: resetForecastPath(), mode: 0o600)
            } catch {
                NSLog("CodeBurn: codex reset-forecast state write failed: %@", String(describing: error))
            }
        }
    }

    /// Called on disconnect, so a reconnect starts from a clean crossing.
    static func clearAll() async {
        await ResetForecastLock.shared.run {
            try? FileManager.default.removeItem(atPath: resetForecastPath())
        }
    }
}

// MARK: - Announcer

/// Wires the pure detector to the existing notification path. Owns no fetch and
/// no timer: it is handed a reading that the refresh already computed from a
/// bundled file.
@MainActor
final class CodexResetForecastAnnouncer {
    private let defaults: UserDefaults
    private let store: any CodexResetForecastStateStoring
    private let makeNotifier: @MainActor () -> any UpdateNotifier
    private var notifier: (any UpdateNotifier)?
    private var isObserving = false

    init(
        defaults: UserDefaults = .standard,
        store: any CodexResetForecastStateStoring = CodexResetForecastStore(),
        makeNotifier: @escaping @MainActor () -> any UpdateNotifier = { SystemUpdateNotifier() }
    ) {
        self.defaults = defaults
        self.store = store
        self.makeNotifier = makeNotifier
    }

    func observe(_ result: CodexResetForecast.Result?, now: Date = Date()) async {
        // The load/save pair spans two awaits; a second refresh landing inside
        // it would judge against pre-save state and post twice. Skipping is
        // free — the next refresh sees the same forecast.
        guard !isObserving else { return }
        isObserving = true
        defer { isObserving = false }

        var reading: CodexResetForecast.Reading?
        if case let .available(value) = result { reading = value }

        let threshold = CodexResetForecastThresholdPreference.value(defaults: defaults)
        let state = await store.load()
        let outcome = CodexResetForecastCrossingDetector.evaluate(
            reading: reading, state: state, threshold: threshold, now: now
        )
        if outcome.state != state { await store.save(outcome.state) }
        guard let fired = outcome.fire else { return }
        // The crossing is recorded either way, so turning the switch on does not
        // release a backlog of crossings that happened while it was off.
        guard CodexResetForecastNotificationPreference.isEnabled(defaults: defaults) else { return }
        let notifier = notifier ?? makeNotifier()
        self.notifier = notifier
        guard await notifier.requestAuthorizationIfNeeded() else { return }
        let copy = CodexResetForecastPresentation.notice(for: fired)
        notifier.post(
            title: copy.title,
            body: copy.body,
            identifier: "CodexResetForecast.\(Int(fired.lastResetAt.timeIntervalSince1970.rounded())).\(Int(threshold * 100))"
        )
    }
}
