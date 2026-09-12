import Foundation

/// Keeps the Codex reset history fresher than a release cycle.
///
/// #725 exception granted by the maintainer on 2026-09-13: a client-side,
/// first-party, conditional fetch of the reset-history dataset from this
/// repository on GitHub, at most hourly, carrying no user data; no request is
/// ever made to codex-reset.com or any third party from the client.
///
/// What that buys, and what it costs:
///
/// - **One host, and not a new one.** `api.github.com`, which `UpdateChecker`
///   already contacts every two days. `raw.githubusercontent.com` would have
///   been a host this app has never spoken to, so the contents API is used
///   instead, on the endpoint that returns the file itself.
/// - **A conditional GET.** The stored ETag goes out as `If-None-Match`, so the
///   common answer is a 304 with no body, costing one request against the
///   unauthenticated 60-per-hour limit.
/// - **At most once an hour**, on the refresh that already runs. No new timer,
///   and the attempt is detached, so nothing in the UI ever waits on it.
/// - **Nothing about the user leaves.** No credential, no cookie, no account id,
///   no plan, no usage. The request carries an `Accept`, a product `User-Agent`
///   and, when there is one, an ETag.
/// - **A failure is never worse than not trying.** The record compiled into the
///   build is the floor; a fetched record is only adopted if it validates and is
///   strictly newer than what is already held.
enum CodexResetHistoryRefreshPreference {
    static let defaultsKey = "codeburn.codex.resetHistoryRefreshEnabled"

    /// Absent key is true. This one defaults on because, unlike the
    /// notification, it makes an existing number more accurate rather than
    /// adding an interruption.
    static func isEnabled(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: defaultsKey) as? Bool ?? true
    }
}

/// What the fetcher remembers between attempts and across relaunches.
struct CodexResetHistoryCache: Codable, Equatable, Sendable {
    /// When the last request went out, successful or not. Gates the hourly
    /// retry, so a machine with no network tries once an hour rather than on
    /// every refresh.
    var attemptedAt: Date
    var etag: String?
    var document: CodexResetForecast.History?
}

/// Which copy the forecast is reading, for the provenance line.
enum CodexResetHistorySource: String, Equatable, Sendable {
    case bundled
    case fetched
}

struct CodexResetHistoryResolution: Equatable, Sendable {
    let history: CodexResetForecast.History?
    let source: CodexResetHistorySource
}

/// Pure decision layer, so every rule below is testable without a network, a
/// clock or a disk.
enum CodexResetHistoryPolicy {
    /// At most one attempt per hour.
    static let minimumInterval: TimeInterval = 60 * 60

    static let url = URL(string:
        "https://api.github.com/repos/getagentseal/codeburn/contents/src/data/codex-reset-history.json"
        + "?ref=data/codex-reset-history")!

    static var host: String { url.host ?? "" }

    static func isDue(cache: CodexResetHistoryCache?, now: Date) -> Bool {
        guard let cache else { return true }
        return now.timeIntervalSince(cache.attemptedAt) >= minimumInterval
    }

    /// The newer of the two records. The bundled copy is the floor: a fetch can
    /// only ever move the record forward, never replace it with something older.
    static func resolve(
        bundled: CodexResetForecast.History?,
        cached: CodexResetForecast.History?
    ) -> CodexResetHistoryResolution {
        guard let cached else { return .init(history: bundled, source: .bundled) }
        guard let bundled else { return .init(history: cached, source: .fetched) }
        let cachedAt = CodexResetForecast.generatedAt(cached) ?? .distantPast
        let bundledAt = CodexResetForecast.generatedAt(bundled) ?? .distantPast
        return cachedAt > bundledAt
            ? .init(history: cached, source: .fetched)
            : .init(history: bundled, source: .bundled)
    }

    /// The cache to persist after one attempt. A 304 keeps what is held and
    /// restarts the clock; a 200 is adopted only if it validates and is strictly
    /// newer than the best record already on hand; anything else is silence.
    /// `Retry-After` pushes the next attempt out rather than sleeping here.
    static func apply(
        status: Int,
        body: Data?,
        etag: String?,
        retryAfterSeconds: TimeInterval?,
        cache: CodexResetHistoryCache?,
        bundled: CodexResetForecast.History?,
        now: Date
    ) -> CodexResetHistoryCache {
        var next = CodexResetHistoryCache(
            attemptedAt: now, etag: cache?.etag, document: cache?.document
        )
        if status == 200, let body, let candidate = CodexResetForecast.validated(rawJSON: body) {
            let best = CodexResetForecast.generatedAt(cache?.document ?? bundled) ?? .distantPast
            if (CodexResetForecast.generatedAt(candidate) ?? .distantPast) > best {
                next.document = candidate
                next.etag = etag ?? cache?.etag
            }
        }
        if let retryAfterSeconds, retryAfterSeconds > 0 {
            next.attemptedAt = now.addingTimeInterval(retryAfterSeconds - minimumInterval)
        }
        return next
    }
}

// MARK: - Persistence

protocol CodexResetHistoryCacheStoring: Sendable {
    func load() async -> CodexResetHistoryCache?
    func save(_ cache: CodexResetHistoryCache) async
}

private let resetHistoryCacheFilename = "codex-reset-history-fetched.json"

private func resetHistoryCachePath() -> String {
    (CodeBurnCacheDirectory.resolve() as NSString).appendingPathComponent(resetHistoryCacheFilename)
}

private actor ResetHistoryCacheLock {
    static let shared = ResetHistoryCacheLock()
    func run<T>(_ fn: () throws -> T) rethrows -> T { try fn() }
}

/// One JSON document in the CodeBurn cache directory, serialized behind an
/// actor and written 0600 through `SafeFile`, the same shape as every other
/// cache this app keeps.
struct CodexResetHistoryCacheStore: CodexResetHistoryCacheStoring {
    func load() async -> CodexResetHistoryCache? {
        await ResetHistoryCacheLock.shared.run {
            let path = resetHistoryCachePath()
            guard FileManager.default.fileExists(atPath: path),
                  let data = try? SafeFile.read(from: path) else { return nil }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            guard var cache = try? decoder.decode(CodexResetHistoryCache.self, from: data) else { return nil }
            // A cached document that no longer passes today's rules is dropped
            // rather than trusted because it was trusted once.
            if let document = cache.document,
               let re = try? JSONEncoder().encode(document),
               CodexResetForecast.validated(rawJSON: re) == nil {
                cache.document = nil
            }
            return cache
        }
    }

    func save(_ cache: CodexResetHistoryCache) async {
        await ResetHistoryCacheLock.shared.run {
            do {
                let encoder = JSONEncoder()
                encoder.dateEncodingStrategy = .iso8601
                try SafeFile.write(encoder.encode(cache), to: resetHistoryCachePath(), mode: 0o600)
            } catch {
                NSLog("CodeBurn: codex reset-history cache write failed: %@", String(describing: error))
            }
        }
    }
}

// MARK: - Fetcher

/// Drives the policy against the network. Owns no timer: the Codex quota
/// refresh calls it, and it decides whether anything is due.
actor CodexResetHistoryFetcher {
    typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    private let store: any CodexResetHistoryCacheStoring
    private let transport: Transport
    private var inFlight = false
    private var cache: CodexResetHistoryCache?
    private var loadedCache = false

    init(
        store: any CodexResetHistoryCacheStoring = CodexResetHistoryCacheStore(),
        transport: @escaping Transport = { try await URLSession.shared.data(for: $0) }
    ) {
        self.store = store
        self.transport = transport
    }

    /// The record to forecast from right now, without touching the network.
    func resolution(bundled: CodexResetForecast.History?) async -> CodexResetHistoryResolution {
        await ensureCacheLoaded()
        return CodexResetHistoryPolicy.resolve(bundled: bundled, cached: cache?.document)
    }

    /// Refresh if an hour has passed. Returns the resolution after the attempt,
    /// so a caller that wants to redraw can; callers that do not care simply
    /// discard it. Never throws.
    @discardableResult
    func refreshIfDue(
        bundled: CodexResetForecast.History?,
        enabled: Bool,
        now: Date = Date()
    ) async -> CodexResetHistoryResolution {
        await ensureCacheLoaded()
        // The switch being off means the bundled record and nothing else: no
        // request, and no previously fetched copy either.
        guard enabled else { return .init(history: bundled, source: .bundled) }
        // Single-flight. A second refresh landing inside the first would make a
        // duplicate request and judge against pre-save state.
        guard !inFlight, CodexResetHistoryPolicy.isDue(cache: cache, now: now) else {
            return CodexResetHistoryPolicy.resolve(bundled: bundled, cached: cache?.document)
        }
        inFlight = true
        defer { inFlight = false }

        var request = URLRequest(url: CodexResetHistoryPolicy.url)
        // The raw media type returns the file itself rather than a base64
        // envelope, on the same host and the same endpoint.
        request.setValue("application/vnd.github.raw+json", forHTTPHeaderField: "Accept")
        request.setValue("codeburn-menubar-reset-history", forHTTPHeaderField: "User-Agent")
        if let etag = cache?.etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        // Nothing else is ever set on this request. No credential, no cookie,
        // no account id, no plan, no usage.
        request.httpShouldHandleCookies = false

        var next: CodexResetHistoryCache
        do {
            let (data, response) = try await transport(request)
            let http = response as? HTTPURLResponse
            let retryAfter = (http?.value(forHTTPHeaderField: "Retry-After")).flatMap(TimeInterval.init)
            next = CodexResetHistoryPolicy.apply(
                status: http?.statusCode ?? 0,
                body: data,
                etag: http?.value(forHTTPHeaderField: "ETag"),
                retryAfterSeconds: retryAfter,
                cache: cache,
                bundled: bundled,
                now: now
            )
        } catch {
            // Offline, DNS down, timed out. Recorded as an attempt, so this is
            // tried once an hour rather than on every refresh.
            next = CodexResetHistoryCache(attemptedAt: now, etag: cache?.etag, document: cache?.document)
        }

        cache = next
        await store.save(next)
        return CodexResetHistoryPolicy.resolve(bundled: bundled, cached: next.document)
    }

    private func ensureCacheLoaded() async {
        guard !loadedCache else { return }
        loadedCache = true
        cache = await store.load()
    }
}
