import Foundation

/// Chance of an OpenAI Codex usage-limit reset landing soon, estimated from the
/// public record of past resets.
///
/// This is the Swift mirror of `src/reset-forecast.ts`. It exists because the
/// menubar does not read quota from the CLI payload: `codeburn status --format
/// menubar-json` carries cost, sessions, providers and pricing, but no quota
/// block at all — the menubar's quota comes from its own native adapters
/// (`CodexSubscriptionService` and friends). So unlike pricing, which reaches
/// the menubar through the payload, this has to be computed here, over a
/// byte-identical copy of the same committed dataset.
///
/// The two files are mirrored deliberately, constant for constant and word for
/// word, so `codeburn quota` and the menubar print the same sentence. Change
/// one and change the other.
///
/// Nothing here fetches anything. The dataset is a bundled file, refreshed only
/// by `.github/workflows/refresh-codex-reset-history.yml`.
enum CodexResetForecast {

    // MARK: - Constants (mirrored from src/reset-forecast.ts)

    /// Waits ending inside this window count `recentWeight`; older ones count 1.
    /// Both public trackers note the cadence sped up, so the full record alone
    /// would understate the chance.
    static let recentWindowDays: Double = 120
    static let recentWeight: Double = 3

    /// A record older than this is out of date, and the client says so.
    static let staleAfterDays: Double = 14

    /// The hour-of-day prior scales the hazard but never zeroes it. Six hours of
    /// the San Francisco night carry no reset at all in the record, and "never"
    /// is not a claim 44 events can support.
    static let minHourMultiplier: Double = 0.1

    /// No estimate from a record this size is entitled to say "certain". The
    /// hour prior can multiply a hazard by up to 24, which turns an already high
    /// probability into 100%; this is the ceiling that stops it.
    static let maxProbability: Double = 0.99

    /// Below this many waits there is nothing to condition on.
    static let minWaitsForForecast = 3

    /// Below this many waits the backtest cannot earn anything, whatever it says.
    static let minWaitsForConfidence = 20

    /// Shrinkage strength for the conditional estimate. Deep in the tail the
    /// at-risk set thins to one or two waits, where the raw empirical share is 0
    /// or 1 and reads as certainty; the estimate is pulled toward a memoryless
    /// rate in proportion to how thin it is.
    static let shrinkagePseudoCount: Double = 5

    /// The San Francisco band the record actually lands in: 07:00-23:00 PT, any
    /// day. 42 of the 44 shipped resets fall inside it, and the weekday counts
    /// are close to flat, so restricting this to Monday-Friday would describe a
    /// pattern the record does not show.
    static let workingHoursStart = 7
    static let workingHoursEnd = 23

    /// Probe offsets after a reset, in hours, used by the walk-forward backtest.
    static let backtestProbeOffsetsHours: [Double] = [3, 6, 12, 24, 36, 48, 72, 96, 144, 192]

    static let sanFranciscoTimeZone = TimeZone(identifier: "America/Los_Angeles")

    private static let hourSeconds: Double = 3600
    private static let daySeconds: Double = 86_400

    // MARK: - Types

    enum Confidence: String, Equatable, Sendable {
        case low
        case moderate
    }

    enum LastResetSource: String, Equatable, Sendable {
        case global
        case local
    }

    struct ProbabilityRange: Equatable, Sendable {
        let point: Double
        let low: Double
        let high: Double
    }

    /// A reset this machine observed for itself rather than one from the public
    /// record. The early-quota-reset detector (#1320) and the banked-credit
    /// watcher (#1322) are the intended sources; this is an input, not an
    /// import, so neither has to land before the forecast works. With none, the
    /// forecast conditions on the global record.
    struct LocalResetEvent: Equatable, Sendable {
        enum Origin: String, Equatable, Sendable {
            case localEarlyReset
            case bankedCredit
        }

        let at: Date
        let origin: Origin
    }

    struct Reading: Equatable, Sendable {
        let stale: Bool
        let datasetAgeDays: Double
        let datasetGeneratedAt: Date?
        let source: String
        let resetCount: Int
        let waitCount: Int
        let lastResetAt: Date
        let lastResetSource: LastResetSource
        let hoursSinceLastReset: Double
        let typicalWaitHours: Double
        let within6h: ProbabilityRange
        let within24h: ProbabilityRange
        let sanFranciscoHour: Int
        let workingHoursSF: Bool
        let beyondRecord: Bool
        let confidence: Confidence
    }

    enum Result: Equatable, Sendable {
        case available(Reading)
        /// Nothing can be said, and why. Never substituted with a zero.
        case unavailable(reason: String, stale: Bool)
    }

    // MARK: - Dataset

    struct History: Codable, Equatable, Sendable {
        struct Event: Codable, Equatable, Sendable {
            let id: String
            let announcedAt: String
            let type: String
            let resetKind: String?

            enum CodingKeys: String, CodingKey {
                case id
                case announcedAt = "announced_at"
                case type
                case resetKind = "reset_kind"
            }
        }

        let schema: Int
        let source: String
        let generatedAt: String
        let events: [Event]

        enum CodingKeys: String, CodingKey {
            case schema
            case source
            case generatedAt = "generated_at"
            case events
        }
    }

    /// The bundled record, decoded once. A build whose resource is missing or
    /// unreadable gets nil, which renders as "unavailable" rather than as a
    /// forecast over an empty record.
    ///
    /// `Bundle.module` only exists under SwiftPM, which is how the app is built.
    /// The guard is what lets the model be compiled on its own by the standalone
    /// `swiftc` harness the repo uses in place of `swift test`.
    static let bundled: History? = {
        #if SWIFT_PACKAGE
        guard let url = Bundle.module.url(
            forResource: "codex-reset-history",
            withExtension: "json",
            subdirectory: "CodexResetHistory"
        ) ?? Bundle.module.url(forResource: "codex-reset-history", withExtension: "json"),
            let data = try? Data(contentsOf: url)
        else { return nil }
        return try? JSONDecoder().decode(History.self, from: data)
        #else
        return nil
        #endif
    }()

    /// Whether a record that arrived at runtime is one this build can use.
    ///
    /// Applied to the raw bytes, not to the decoded value: `Decodable` silently
    /// drops keys it does not know, so a document carrying post text would
    /// decode cleanly and the one rule that matters most — nothing beyond the
    /// four fields — could not be checked afterwards. Mirrors
    /// `isUsableResetHistory` in `src/reset-forecast.ts`.
    static func validated(rawJSON: Data) -> History? {
        guard let root = try? JSONSerialization.jsonObject(with: rawJSON) as? [String: Any] else { return nil }
        guard root["schema"] as? Int == 1 else { return nil }
        guard let source = root["source"] as? String, !source.isEmpty else { return nil }
        guard let generatedAt = root["generated_at"] as? String, parseISO(generatedAt) != nil else { return nil }
        guard let events = root["events"] as? [[String: Any]] else { return nil }

        let allowed: Set<String> = ["id", "announced_at", "type", "reset_kind"]
        var seen = Set<String>()
        var previous = ""
        var resets = 0
        for event in events {
            guard Set(event.keys).isSubset(of: allowed) else { return nil }
            guard let id = event["id"] as? String,
                  !id.trimmingCharacters(in: .whitespaces).isEmpty,
                  !seen.contains(id) else { return nil }
            seen.insert(id)
            guard let type = event["type"] as? String, type == "reset" || type == "credits" else { return nil }
            guard let at = event["announced_at"] as? String, parseISO(at) != nil else { return nil }
            // Monotonic, which is what makes the inter-reset waits meaningful.
            if !previous.isEmpty, at < previous { return nil }
            previous = at
            if type == "reset" {
                guard let kind = event["reset_kind"] as? String,
                      kind.range(of: "^[a-z0-9][a-z0-9_-]{0,31}$", options: .regularExpression) != nil
                else { return nil }
                resets += 1
            } else if event["reset_kind"] != nil {
                return nil
            }
        }
        // A record with almost nothing in it is not an improvement on the
        // bundled one.
        guard resets >= 2 else { return nil }
        return try? JSONDecoder().decode(History.self, from: rawJSON)
    }

    /// The record's own build time, for choosing between two copies.
    static func generatedAt(_ history: History?) -> Date? {
        parseISO(history?.generatedAt)
    }

    /// `ISO8601DateFormatter` is a non-Sendable class, so it is built where it is
    /// used rather than cached in a static — the same shape every other
    /// subscription service in this target uses. One parser serves a whole
    /// decode pass, so the record is not re-instantiating a formatter per event.
    struct ISOParser {
        private let plain: ISO8601DateFormatter
        private let fractional: ISO8601DateFormatter

        init() {
            plain = ISO8601DateFormatter()
            plain.formatOptions = [.withInternetDateTime]
            fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        }

        func date(from value: String?) -> Date? {
            guard let value, !value.isEmpty else { return nil }
            return plain.date(from: value) ?? fractional.date(from: value)
        }
    }

    static func parseISO(_ value: String?) -> Date? {
        ISOParser().date(from: value)
    }

    /// Reset instants in the record, ascending, de-duplicated, unparseable dropped.
    static func resetInstants(_ history: History?) -> [Date] {
        guard let history else { return [] }
        let parser = ISOParser()
        var seen = Set<TimeInterval>()
        for event in history.events where event.type == "reset" {
            guard let at = parser.date(from: event.announcedAt) else { continue }
            seen.insert(at.timeIntervalSince1970)
        }
        return seen.sorted().map { Date(timeIntervalSince1970: $0) }
    }

    // MARK: - Clock

    /// Built where it is used, for the same non-Sendable reason as the parser.
    static func sanFranciscoCalendar() -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = sanFranciscoTimeZone ?? TimeZone(secondsFromGMT: 0)!
        return calendar
    }

    static func sanFranciscoHour(_ at: Date, calendar: Calendar) -> Int {
        calendar.component(.hour, from: at)
    }

    static func sanFranciscoHour(_ at: Date) -> Int {
        sanFranciscoHour(at, calendar: sanFranciscoCalendar())
    }

    static func isWorkingHoursSF(_ at: Date) -> Bool {
        let hour = sanFranciscoHour(at)
        return hour >= workingHoursStart && hour < workingHoursEnd
    }

    // MARK: - Model

    private struct Wait {
        let hours: Double
        let weight: Double
    }

    private static func waits(from instants: [Date], reference: Date) -> [Wait] {
        let cutoff = reference.addingTimeInterval(-recentWindowDays * daySeconds)
        var result: [Wait] = []
        for index in 1..<max(instants.count, 1) where instants.count > 1 {
            let hours = instants[index].timeIntervalSince(instants[index - 1]) / hourSeconds
            // A non-positive wait means two announcements share an instant; it
            // carries no information about how long anyone waited.
            guard hours > 0 else { continue }
            result.append(Wait(hours: hours, weight: instants[index] >= cutoff ? recentWeight : 1))
        }
        return result
    }

    private static func weightedMedian(_ waits: [Wait]) -> Double {
        let sorted = waits.sorted { $0.hours < $1.hours }
        let total = sorted.reduce(0) { $0 + $1.weight }
        guard total > 0, let last = sorted.last else { return 0 }
        var running: Double = 0
        for wait in sorted {
            running += wait.weight
            if running >= total / 2 { return wait.hours }
        }
        return last.hours
    }

    /// Wilson score interval. Used instead of a normal approximation because the
    /// counts here are small and often land at 0 or n, where the normal interval
    /// collapses to a point and would read as certainty.
    static func wilsonInterval(successes: Int, trials: Int, z: Double = 1.96) -> (low: Double, high: Double) {
        guard trials > 0 else { return (0, 1) }
        let n = Double(trials)
        let p = Double(successes) / n
        let z2 = z * z
        let denominator = 1 + z2 / n
        let centre = p + z2 / (2 * n)
        let spread = z * ((p * (1 - p) + z2 / (4 * n)) / n).squareRoot()
        return (clamp01((centre - spread) / denominator), clamp01((centre + spread) / denominator))
    }

    static func clamp01(_ value: Double) -> Double {
        guard value.isFinite else { return 0 }
        return min(1, max(0, value))
    }

    /// Hazard-space multiply, so a multiplier can never push a probability above
    /// 1 or (given `minHourMultiplier`) down to exactly 0.
    private static func scale(_ probability: Double, by multiplier: Double) -> Double {
        let p = min(max(probability, 0), 0.999)
        guard p > 0 else { return 0 }
        let hazard = -log(1 - p)
        return min(maxProbability, clamp01(1 - exp(-hazard * max(multiplier, 0))))
    }

    /// Weighted hour-of-day density in San Francisco, as a multiplier against a
    /// uniform day. Floored per hour so the prior tilts the estimate and never
    /// erases it.
    private static func hourMultipliers(_ instants: [Date], reference: Date) -> [Double] {
        let cutoff = reference.addingTimeInterval(-recentWindowDays * daySeconds)
        let calendar = sanFranciscoCalendar()
        var buckets = [Double](repeating: 0, count: 24)
        var total: Double = 0
        for at in instants {
            let weight = at >= cutoff ? recentWeight : 1
            buckets[sanFranciscoHour(at, calendar: calendar)] += weight
            total += weight
        }
        guard total > 0 else { return [Double](repeating: 1, count: 24) }
        return buckets.map { max(minHourMultiplier, ($0 / total) * 24) }
    }

    /// Average hour multiplier over the next `horizonHours`, hour by hour, so a
    /// 24h horizon is barely tilted while a 6h horizon starting at 3am is.
    private static func horizonMultiplier(_ multipliers: [Double], now: Date, horizonHours: Double) -> Double {
        guard horizonHours > 0 else { return 1 }
        let calendar = sanFranciscoCalendar()
        var weighted: Double = 0
        var covered: Double = 0
        var offset: Double = 0
        while offset < horizonHours {
            let step = min(1, horizonHours - offset)
            let at = now.addingTimeInterval((offset + step / 2) * hourSeconds)
            weighted += multipliers[sanFranciscoHour(at, calendar: calendar)] * step
            covered += step
            offset += step
        }
        return covered > 0 ? weighted / covered : 1
    }

    private struct Estimate {
        let range: ProbabilityRange
        let beyondRecord: Bool
    }

    /// P(a reset lands within `horizonHours`), conditioned on `elapsedHours`
    /// already having passed since the last one. The plain empirical conditional
    /// distribution of waits, which for a fully observed record is what
    /// Kaplan-Meier reduces to, shrunk toward a memoryless rate where the
    /// at-risk set is thin, with the hour-of-day prior applied in hazard space.
    private static func estimate(
        waits: [Wait],
        multipliers: [Double],
        elapsedHours: Double,
        now: Date,
        horizonHours: Double
    ) -> Estimate {
        let atRisk = waits.filter { $0.hours > elapsedHours }
        let multiplier = horizonMultiplier(multipliers, now: now, horizonHours: horizonHours)
        let totalWeight = waits.reduce(0) { $0 + $1.weight }
        let meanWait = totalWeight > 0 ? waits.reduce(0) { $0 + $1.hours * $1.weight } / totalWeight : 0
        let memoryless = meanWait > 0 ? 1 - exp(-horizonHours / meanWait) : 0

        if atRisk.isEmpty {
            // Longer than anything in the record. There is no at-risk set to
            // divide by, so the memoryless rate is all that is left, and the
            // range opens to the full span rather than pretending the record
            // still says something.
            return Estimate(
                range: ProbabilityRange(point: scale(memoryless, by: multiplier), low: 0, high: 1),
                beyondRecord: true
            )
        }

        let riskWeight = atRisk.reduce(0) { $0 + $1.weight }
        let hit = atRisk.filter { $0.hours <= elapsedHours + horizonHours }
        let hitWeight = hit.reduce(0) { $0 + $1.weight }
        let empirical = riskWeight > 0 ? hitWeight / riskWeight : 0
        let lambda = Double(atRisk.count) / (Double(atRisk.count) + shrinkagePseudoCount)
        let point = lambda * empirical + (1 - lambda) * memoryless
        // The interval is computed on the honest unweighted counts: weighting
        // and shrinkage are judgements, not extra observations, and must not
        // narrow the range. It is then widened, never narrowed, to contain the
        // point estimate.
        let interval = wilsonInterval(successes: hit.count, trials: atRisk.count)
        let scaledPoint = scale(point, by: multiplier)
        return Estimate(
            range: ProbabilityRange(
                point: scaledPoint,
                low: min(scale(interval.low, by: multiplier), scaledPoint),
                high: max(scale(interval.high, by: multiplier), scaledPoint)
            ),
            beyondRecord: false
        )
    }

    /// The forecast, or a stated reason there isn't one.
    static func evaluate(
        history: History?,
        now: Date,
        localEvents: [LocalResetEvent] = []
    ) -> Result {
        let generatedAt = parseISO(history?.generatedAt)
        let datasetAgeDays = generatedAt.map { now.timeIntervalSince($0) / daySeconds } ?? .infinity
        let stale = !(datasetAgeDays <= staleAfterDays)

        let instants = resetInstants(history)
        guard let globalLast = instants.last else {
            return .unavailable(reason: "No reset history is bundled with this build.", stale: stale)
        }
        // A record generated in this machine's future is skew, not a fresh
        // dataset. Tolerate an hour for a slow clock; beyond that, say nothing.
        if generatedAt != nil, datasetAgeDays < -1.0 / 24.0 {
            return .unavailable(reason: "The reset history is dated in the future; check this machine's clock.", stale: false)
        }

        var lastResetAt = globalLast
        var lastResetSource = LastResetSource.global
        for event in localEvents {
            // A local event from the future is skew; one older than the global
            // record tells us nothing the record does not already say.
            guard event.at <= now, event.at > lastResetAt else { continue }
            lastResetAt = event.at
            lastResetSource = .local
        }

        let elapsedHours = now.timeIntervalSince(lastResetAt) / hourSeconds
        guard elapsedHours >= 0 else {
            return .unavailable(reason: "The last reset is dated in the future; check this machine's clock.", stale: stale)
        }

        // Waits are anchored on the record's own reference point, not on `now`:
        // a stale dataset must not silently drop every wait out of the recent
        // window.
        let reference = max(generatedAt ?? globalLast, globalLast)
        let waitList = waits(from: instants, reference: reference)
        guard waitList.count >= minWaitsForForecast else {
            let plural = waitList.count == 1 ? "" : "s"
            return .unavailable(
                reason: "Only \(waitList.count) inter-reset wait\(plural) in the record; not enough to say anything.",
                stale: stale
            )
        }

        let multipliers = hourMultipliers(instants, reference: reference)
        let six = estimate(waits: waitList, multipliers: multipliers, elapsedHours: elapsedHours, now: now, horizonHours: 6)
        let day = estimate(waits: waitList, multipliers: multipliers, elapsedHours: elapsedHours, now: now, horizonHours: 24)
        let beyondRecord = six.beyondRecord || day.beyondRecord
        // 24 hours contain the next 6, so the longer horizon cannot be the less
        // likely one. The survival term alone guarantees that; the hour-of-day
        // prior does not, because a 6h window can sit entirely inside the
        // record's busiest hours while the 24h window averages across the quiet
        // ones. Raising the 24h figure rather than lowering the 6h one keeps the
        // prior's information and never understates either.
        let within24h = ProbabilityRange(
            point: max(day.range.point, six.range.point),
            low: max(day.range.low, six.range.low),
            high: max(day.range.high, six.range.high)
        )

        let earned = !stale
            && !beyondRecord
            && waitList.count >= minWaitsForConfidence
            && backtest(instants: instants).beatsBaseRate

        return .available(Reading(
            stale: stale,
            datasetAgeDays: datasetAgeDays,
            datasetGeneratedAt: generatedAt,
            source: history?.source ?? "",
            resetCount: instants.count,
            waitCount: waitList.count,
            lastResetAt: lastResetAt,
            lastResetSource: lastResetSource,
            hoursSinceLastReset: elapsedHours,
            typicalWaitHours: weightedMedian(waitList),
            within6h: six.range,
            within24h: within24h,
            sanFranciscoHour: sanFranciscoHour(now),
            workingHoursSF: isWorkingHoursSF(now),
            beyondRecord: beyondRecord,
            confidence: earned ? .moderate : .low
        ))
    }

    // MARK: - Backtest

    struct BacktestResult: Equatable, Sendable {
        let probes: Int
        let modelBrier: Double
        let baseRateBrier: Double
        let beatsBaseRate: Bool
        let horizonHours: Double
    }

    /// Walk-forward validation. For each reset after a burn-in, the model is
    /// rebuilt from that prefix alone and asked, at fixed offsets after that
    /// reset, for the chance the next one lands within the horizon. The answer
    /// is scored against what actually happened, and against a constant
    /// predictor set to the same prefix's base rate. Nothing after the probe is
    /// visible to either predictor, so `beatsBaseRate` is not a fit statistic.
    ///
    /// This is what earns `Confidence.moderate`, and it ships as a test.
    static func backtest(
        history: History?,
        horizonHours: Double = 24,
        burnInWaits: Int = 10
    ) -> BacktestResult {
        backtest(instants: resetInstants(history), horizonHours: horizonHours, burnInWaits: burnInWaits)
    }

    /// The same walk-forward run over already-parsed instants, so `evaluate`
    /// decodes the record once rather than once per caller.
    static func backtest(
        instants: [Date],
        horizonHours: Double = 24,
        burnInWaits: Int = 10
    ) -> BacktestResult {
        let empty = BacktestResult(probes: 0, modelBrier: 0, baseRateBrier: 0, beatsBaseRate: false, horizonHours: horizonHours)
        guard instants.count >= burnInWaits + 2 else { return empty }

        var modelError: Double = 0
        var baseError: Double = 0
        var probes = 0

        for index in burnInWaits..<(instants.count - 1) {
            let prefix = Array(instants[0...index])
            guard let anchor = prefix.last else { continue }
            let next = instants[index + 1]
            let waitList = waits(from: prefix, reference: anchor)
            guard waitList.count >= minWaitsForForecast else { continue }
            let multipliers = hourMultipliers(prefix, reference: anchor)
            guard let baseRate = trainingBaseRate(prefix: prefix, horizonHours: horizonHours) else { continue }

            for offset in backtestProbeOffsetsHours {
                let probeAt = anchor.addingTimeInterval(offset * hourSeconds)
                // The probe has to describe a state that existed: once the next
                // reset has landed, "offset hours since the last reset" is a
                // different situation.
                guard probeAt < next else { continue }
                let outcome: Double = next.timeIntervalSince(probeAt) <= horizonHours * hourSeconds ? 1 : 0
                let predicted = estimate(
                    waits: waitList,
                    multipliers: multipliers,
                    elapsedHours: offset,
                    now: probeAt,
                    horizonHours: horizonHours
                ).range.point
                modelError += pow(predicted - outcome, 2)
                baseError += pow(baseRate - outcome, 2)
                probes += 1
            }
        }

        guard probes > 0 else { return empty }
        let modelBrier = modelError / Double(probes)
        let baseRateBrier = baseError / Double(probes)
        return BacktestResult(
            probes: probes,
            modelBrier: modelBrier,
            baseRateBrier: baseRateBrier,
            beatsBaseRate: modelBrier < baseRateBrier,
            horizonHours: horizonHours
        )
    }

    /// The competitor: one number, the share of probes inside the training
    /// prefix whose next reset landed within the horizon.
    private static func trainingBaseRate(prefix: [Date], horizonHours: Double) -> Double? {
        var hits: Double = 0
        var total: Double = 0
        guard prefix.count > 1 else { return nil }
        for index in 0..<(prefix.count - 1) {
            let anchor = prefix[index]
            let next = prefix[index + 1]
            for offset in backtestProbeOffsetsHours {
                let probeAt = anchor.addingTimeInterval(offset * hourSeconds)
                guard probeAt < next else { continue }
                if next.timeIntervalSince(probeAt) <= horizonHours * hourSeconds { hits += 1 }
                total += 1
            }
        }
        return total > 0 ? hits / total : nil
    }
}
