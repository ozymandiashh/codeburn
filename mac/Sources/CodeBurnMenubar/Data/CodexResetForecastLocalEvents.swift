import Foundation

/// Resets this machine observed for itself, read off the stores the two sibling
/// quota features already persist.
///
/// Why this exists: the bundled reset history is stale by construction — the
/// refresh workflow opens a pull request, somebody merges it, a release is cut,
/// the user updates. The *distribution* of waits barely moves over that lag (44
/// waits do not change shape in a week), but the **last-reset clock** is the
/// model's other input and it must not be frozen at the last release. When a
/// reset lands on this machine, CodeBurn learns of it within one quota refresh
/// cycle, and that is the signal this loader carries into the forecast.
///
/// It decodes through **their own `Codable` types**, so the two shapes cannot
/// drift apart: if either branch changes its record, this stops compiling
/// rather than silently reading nothing.
///
/// It still reads the stores by address rather than calling them, because
/// neither exposes a read this can use:
///
/// - `CodexBankedResetStore.load()` is `async` and hard-wired to the real cache
///   path, with nothing to inject. The forecast is evaluated synchronously, from
///   view bodies.
/// - `EarlyQuotaResetMonitor.visibleEvent(providerID:now:)` applies
///   `EarlyQuotaResetNotice.visibleSeconds`, a twelve-hour *dock-visibility*
///   window. A reset twenty hours ago is no longer worth a band in the dock and
///   is still exactly what "since last reset" should count from, so that filter
///   is wrong here.
///
/// Every failure — absent file, absent key, wrong shape, unreadable dates — is
/// no opinion rather than an error. With neither feature ever having run, the
/// loader returns nothing and the forecast conditions on the global record.
///
/// The two stores are deliberately different in kind, because the two branches
/// chose differently:
///
/// - **#1320** keeps one JSON record per provider in `UserDefaults`, under
///   `EarlyQuotaResetMonitor.defaultsKeyPrefix + providerID`, with
///   `dateEncodingStrategy = .secondsSince1970`. Not a file in the cache
///   directory. Only `latestEvent` is retained, which is exactly the one this
///   needs: the most recent reset that feature announced.
/// - **#1322** writes `codex-banked-resets.json` in the CodeBurn cache directory
///   through `SafeFile`, with `dateEncodingStrategy = .iso8601`.
enum CodexResetForecastLocalEvents {
    /// #1320's `UserDefaults` key prefix, with the provider id appended.
    ///
    /// Spelled out rather than referenced because `EarlyQuotaResetMonitor` is
    /// `@MainActor`, so its static is main-actor-isolated and cannot initialise
    /// a nonisolated one — and this loader is deliberately callable from
    /// anywhere. A test asserts the two are the same string, so drift fails
    /// there instead of silently reading nothing.
    static let earlyResetDefaultsKeyPrefix = "codeburn.quota.earlyReset.state."

    /// #1322's file in the CodeBurn cache directory. Spelled out because that
    /// branch's constant is `private`; a test pins the literal.
    static let bankedResetFilename = "codex-banked-resets.json"

    /// `CapacityDockProvider.codex.rawValue`. Spelled out rather than referenced
    /// so the loader has no opinion about provider plumbing, and checked against
    /// the enum by a test.
    static let codexProviderID = "codex"

    /// Everything this machine has observed that bears on "when did Codex last
    /// reset". Ordered early-reset first, then banked credits; the model takes
    /// the newest that is not in the future, so order is not load-bearing.
    static func load(
        cacheDir: String = CodeBurnCacheDirectory.resolve(),
        defaults: UserDefaults = .standard
    ) -> [CodexResetForecast.LocalResetEvent] {
        earlyResetEvents(defaults: defaults) + bankedCreditEvents(cacheDir: cacheDir)
    }

    // MARK: - #1320, the early-reset detector

    /// A Codex global goodwill reset *is* an early reset of this account's
    /// window, so #1320's detector is the live signal: it fires one refresh
    /// cycle after the reset lands, against no network of its own.
    ///
    /// Filtered to Codex twice over — the per-provider key, and the id carried
    /// inside the record — because an early reset of an Anthropic window says
    /// nothing about when OpenAI last reset Codex, and moving the Codex clock
    /// for it would silently wreck the forecast.
    static func earlyResetEvents(defaults: UserDefaults = .standard) -> [CodexResetForecast.LocalResetEvent] {
        guard let data = defaults.data(forKey: earlyResetDefaultsKeyPrefix + codexProviderID) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        guard let state = try? decoder.decode(EarlyQuotaResetMonitor.ProviderState.self, from: data),
              let event = state.latestEvent,
              event.providerID == codexProviderID,
              event.detectedAt.timeIntervalSince1970.isFinite
        else { return [] }
        let detectedAt = event.detectedAt
        // `detectedAt`, not `scheduledResetAt`: the latter is when the cycle that
        // was cut short *would* have reset, which is in the future and is not
        // when anything happened.
        return [.init(at: detectedAt, origin: .localEarlyReset)]
    }

    // MARK: - #1322, banked credits

    /// A banked credit is a grant rather than a window reset, but it is the same
    /// kind of goodwill event, and the public record counts those rows too. The
    /// store keeps `firstSeenAt` — when CodeBurn first saw the credit — which is
    /// within one refresh cycle of the grant. `grantedAt` is only on that
    /// branch's transient event and never reaches disk, so `firstSeenAt` is the
    /// freshest timestamp available and it errs late, never early.
    static func bankedCreditEvents(cacheDir: String = CodeBurnCacheDirectory.resolve()) -> [CodexResetForecast.LocalResetEvent] {
        let path = (cacheDir as NSString).appendingPathComponent(bankedResetFilename)
        guard FileManager.default.fileExists(atPath: path),
              let data = try? SafeFile.read(from: path) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let state = try? decoder.decode(CodexBankedResetState.self, from: data) else { return [] }
        return state.credits.compactMap { credit in
            guard credit.firstSeenAt.timeIntervalSince1970.isFinite else { return nil }
            return .init(at: credit.firstSeenAt, origin: .bankedCredit)
        }
    }
}
