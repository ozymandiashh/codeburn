import Foundation
import Testing
@testable import CodeBurnMenubar

/// The Codex reset forecast, its wording, and the opt-in crossing notice.
///
/// Two things are being pinned here. First, the model's honesty rules: an
/// absent answer is a stated reason and never a zero, a probability never
/// appears without its range, and the confidence label is whatever the
/// walk-forward backtest earns. Second, exact parity with `src/reset-forecast.ts`
/// — the expected sentences below are the literal output of the TypeScript
/// module on the same fixture, so a change on either side that breaks the pair
/// fails here.
///
/// Every clock is explicit. The model takes `now` as an argument for exactly
/// this reason.
private enum Fixture {
    /// Thirty resets, a flat 48-hour cadence from 2026-01-01T18:00:00Z, each
    /// landing at the same hour. The regularity is the point: it is the shape
    /// the conditional model can actually exploit, so the backtest earns
    /// `moderate` on it, which the real record does not.
    static let cadenceStart = Date(timeIntervalSince1970: 1_767_290_400) // 2026-01-01T18:00:00Z
    static let last = Date(timeIntervalSince1970: 1_772_301_600)         // 2026-02-28T18:00:00Z

    static func times(count: Int = 30, spacingHours: Double = 48, from: Date = cadenceStart) -> [Date] {
        (0..<count).map { from.addingTimeInterval(Double($0) * spacingHours * 3600) }
    }

    static func history(
        _ times: [Date],
        generatedAt: Date? = nil,
        credits: [Date] = []
    ) -> CodexResetForecast.History {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        var events = times.enumerated().map { index, at in
            CodexResetForecast.History.Event(
                id: "r\(index)", announcedAt: formatter.string(from: at), type: "reset", resetKind: "global"
            )
        }
        events += credits.enumerated().map { index, at in
            CodexResetForecast.History.Event(
                id: "c\(index)", announcedAt: formatter.string(from: at), type: "credits", resetKind: nil
            )
        }
        return CodexResetForecast.History(
            schema: 1,
            source: "https://codex-reset.com/api/timeline",
            generatedAt: formatter.string(from: generatedAt ?? times.last ?? cadenceStart),
            events: events
        )
    }

    static let standard = history(times())

    static func reading(elapsedHours: Double, history: CodexResetForecast.History = standard) -> CodexResetForecast.Reading {
        guard case let .available(reading) = CodexResetForecast.evaluate(
            history: history, now: last.addingTimeInterval(elapsedHours * 3600)
        ) else {
            fatalError("expected a forecast at \(elapsedHours)h")
        }
        return reading
    }
}

// MARK: - Unavailable, never zero

@Test func emptyHistoryIsUnavailableWithAReason() {
    let result = CodexResetForecast.evaluate(history: Fixture.history([]), now: Fixture.last)
    guard case let .unavailable(reason, _) = result else { Issue.record("expected unavailable"); return }
    #expect(reason.contains("No reset history"))
}

@Test func missingHistoryIsUnavailable() {
    guard case .unavailable = CodexResetForecast.evaluate(history: nil, now: Fixture.last) else {
        Issue.record("expected unavailable"); return
    }
}

@Test func oneResetYieldsNoWaitsAndSaysSo() {
    let result = CodexResetForecast.evaluate(history: Fixture.history([Fixture.last]), now: Fixture.last.addingTimeInterval(3600))
    guard case let .unavailable(reason, _) = result else { Issue.record("expected unavailable"); return }
    #expect(reason == "Only 0 inter-reset waits in the record; not enough to say anything.")
}

@Test func twoResetsYieldOneWaitAndSaySoInTheSingular() {
    let times = Fixture.times(count: 2)
    let result = CodexResetForecast.evaluate(history: Fixture.history(times), now: times[1].addingTimeInterval(3600))
    guard case let .unavailable(reason, _) = result else { Issue.record("expected unavailable"); return }
    #expect(reason == "Only 1 inter-reset wait in the record; not enough to say anything.")
}

@Test func aNowBeforeTheLastResetIsClockSkewNotAForecast() {
    let result = CodexResetForecast.evaluate(history: Fixture.standard, now: Fixture.cadenceStart)
    guard case let .unavailable(reason, _) = result else { Issue.record("expected unavailable"); return }
    #expect(reason.contains("clock"))
}

@Test func aRecordDatedInTheFutureIsClockSkewNotAForecast() {
    let history = Fixture.history(Fixture.times(), generatedAt: Fixture.last.addingTimeInterval(30 * 86_400))
    let result = CodexResetForecast.evaluate(history: history, now: Fixture.last.addingTimeInterval(3600))
    guard case let .unavailable(reason, stale) = result else { Issue.record("expected unavailable"); return }
    #expect(reason.contains("future"))
    #expect(stale == false)
}

@Test func aNowBeforeTheLastResetIsRefusedEvenWhenTheRecordItselfIsNotFutureDated() {
    // The future-dated-record guard runs first and would hide this one, so the
    // record is dated at its own first event: old, definitely not in the future,
    // and the last reset still sits ahead of `now`.
    let times = Fixture.times()
    let history = Fixture.history(times, generatedAt: times[0])
    let result = CodexResetForecast.evaluate(history: history, now: times[10])
    guard case let .unavailable(reason, _) = result else { Issue.record("expected unavailable"); return }
    #expect(reason == "The last reset is dated in the future; check this machine's clock.")
}

@Test func anHourOfClockDriftOnTheRecordsOwnDateIsTolerated() {
    let history = Fixture.history(Fixture.times(), generatedAt: Fixture.last.addingTimeInterval(1800))
    guard case .available = CodexResetForecast.evaluate(history: history, now: Fixture.last.addingTimeInterval(3600)) else {
        Issue.record("expected a forecast"); return
    }
}

// MARK: - Staleness

@Test func aRecordInsideFourteenDaysIsFresh() {
    #expect(Fixture.reading(elapsedHours: 13 * 24).stale == false)
}

@Test func aRecordPastFourteenDaysIsStaleAndTheCaveatSaysSo() {
    let reading = Fixture.reading(elapsedHours: 21 * 24)
    #expect(reading.stale)
    #expect(reading.confidence == .low)
    let lines = CodexResetForecastPresentation.lines(for: .available(reading))
    #expect(lines[1].contains("days old and out of date"))
}

@Test func aRecordWithNoDateAtAllIsStale() {
    let history = CodexResetForecast.History(
        schema: 1,
        source: "https://codex-reset.com/api/timeline",
        generatedAt: "",
        events: Fixture.standard.events
    )
    guard case let .available(reading) = CodexResetForecast.evaluate(history: history, now: Fixture.last.addingTimeInterval(3600)) else {
        Issue.record("expected a forecast"); return
    }
    #expect(reading.stale)
    #expect(CodexResetForecastPresentation.lines(for: .available(reading))[1].contains("carries no date and is out of date"))
}

// MARK: - The model

@Test func theChanceRisesAsTheWaitLengthens() {
    #expect(Fixture.reading(elapsedHours: 36).within24h.point > Fixture.reading(elapsedHours: 3).within24h.point)
}

@Test func thePointEstimateNeverEscapesItsOwnRange() {
    for elapsed in [1.0, 6, 24, 30, 36, 40, 42, 47, 60, 200] {
        let reading = Fixture.reading(elapsedHours: elapsed)
        for range in [reading.within6h, reading.within24h] {
            #expect(range.low <= range.point + 1e-9)
            #expect(range.high >= range.point - 1e-9)
        }
    }
}

@Test func theSixHourChanceNeverExceedsTheTwentyFourHourOne() {
    for elapsed in [1.0, 12, 30, 44, 47] {
        let reading = Fixture.reading(elapsedHours: elapsed)
        #expect(reading.within6h.point <= reading.within24h.point + 1e-9)
    }
}

@Test func theRangeWidensUpwardWhenShrinkageLiftsThePointPastItsUpperBound() {
    // Two hundred resets three hours apart, then one long outage. At a probe
    // early in a new wait the at-risk set is the single long wait, so the
    // empirical share is 0 and the Wilson bound is narrow, while the memoryless
    // rate from a three-hour cadence is very high. The shrunk point lands above
    // that bound, and the range has to move up to contain it.
    var at = Date(timeIntervalSince1970: 1_780_344_000) // 2026-06-01T20:00:00Z
    var times = [at]
    for _ in 0..<200 { at = at.addingTimeInterval(3 * 3600); times.append(at) }
    at = at.addingTimeInterval(600 * 3600)
    times.append(at)

    guard case let .available(reading) = CodexResetForecast.evaluate(
        history: Fixture.history(times), now: at.addingTimeInterval(6 * 3600)
    ) else { Issue.record("expected a forecast"); return }
    #expect(reading.beyondRecord == false)
    #expect(reading.within24h.point > 0.8)
    #expect(reading.within24h.high == reading.within24h.point)
}

@Test func noEstimateEverReachesCertainty() {
    for elapsed in [44.0, 46, 47.5] {
        let reading = Fixture.reading(elapsedHours: elapsed)
        #expect(reading.within6h.point <= CodexResetForecast.maxProbability)
        #expect(reading.within24h.high <= CodexResetForecast.maxProbability)
    }
}

@Test func theRecentCadenceWinsOverTheWholeRecordWhenTheTwoDisagree() {
    // Thirty waits of ten days, then twenty of one day: the cadence sped up,
    // which is what both public trackers report of the real record. The
    // unweighted median is still ten days; the weighted one is one day.
    var at = Date(timeIntervalSince1970: 1_735_757_400) // 2025-01-01T18:10:00Z
    var times = [at]
    for _ in 0..<30 { at = at.addingTimeInterval(240 * 3600); times.append(at) }
    for _ in 0..<20 { at = at.addingTimeInterval(24 * 3600); times.append(at) }

    var waits: [Double] = []
    for index in 1..<times.count { waits.append(times[index].timeIntervalSince(times[index - 1]) / 3600) }
    #expect(waits.sorted()[waits.count / 2] == 240)

    guard case let .available(reading) = CodexResetForecast.evaluate(
        history: Fixture.history(times), now: at.addingTimeInterval(6 * 3600)
    ) else { Issue.record("expected a forecast"); return }
    #expect(reading.typicalWaitHours == 24)
    #expect(CodexResetForecast.recentWeight > 1)
}

@Test func aWaitLongerThanAnyInTheRecordSaysSoAndOpensTheRange() {
    let reading = Fixture.reading(elapsedHours: 400)
    #expect(reading.beyondRecord)
    #expect(reading.within24h.low == 0)
    #expect(reading.within24h.high == 1)
    // Still a number, from a memoryless fallback — not a silence and not a zero.
    #expect(reading.within24h.point > 0)
    #expect(reading.confidence == .low)
    #expect(CodexResetForecastPresentation.lines(for: .available(reading))[1]
        .contains("longer than any in that record"))
}

// MARK: - The San Francisco hour-of-day prior

/// A record that lands only at 09:00, 11:00, 13:00, 15:00 and 17:00 San
/// Francisco time and never in the small hours, with every wait at least 40
/// hours. At any probe under 34 hours the six-hour hit set is empty, so the
/// survival term is identical between two such probes and whatever differs is
/// the hour-of-day prior and nothing else.
private enum DaytimeFixture {
    static let times: [Date] = {
        let cycle = [9, 11, 13, 15, 17]
        var at = Date(timeIntervalSince1970: 1_780_329_600) // 2026-06-01T16:00:00Z, 09:00 PDT
        var result = [at]
        for index in 1..<30 {
            let delta = Double(cycle[index % 5] - cycle[(index - 1) % 5])
            at = at.addingTimeInterval((48 + delta) * 3600)
            result.append(at)
        }
        return result
    }()

    static let history = Fixture.history(times)
    static var last: Date { times[times.count - 1] }

    static func reading(elapsedHours: Double) -> CodexResetForecast.Reading {
        guard case let .available(reading) = CodexResetForecast.evaluate(
            history: history, now: last.addingTimeInterval(elapsedHours * 3600)
        ) else { fatalError("expected a forecast") }
        return reading
    }
}

@Test func theDaytimeFixtureHasNoResetBetweenMidnightAndEightPT() {
    let hours = Set(DaytimeFixture.times.map { CodexResetForecast.sanFranciscoHour($0) })
    for hour in 0..<8 { #expect(!hours.contains(hour)) }
    #expect(hours.sorted() == [9, 11, 13, 15, 17])
}

@Test func theSixHourChanceIsSuppressedAcrossTheEmptyNightWindow() {
    let night = DaytimeFixture.reading(elapsedHours: 10)   // 03:00 PT, window 03:00-09:00
    let day = DaytimeFixture.reading(elapsedHours: 18)     // 11:00 PT, window 11:00-17:00
    #expect(night.sanFranciscoHour == 3)
    #expect(day.sanFranciscoHour == 11)
    #expect(night.within6h.point < day.within6h.point)
    // And by a lot: the prior is doing real work, not rounding.
    #expect(night.within6h.point * 3 < day.within6h.point)
}

@Test func thePriorNeverTakesAProbabilityToExactlyZero() {
    let night = DaytimeFixture.reading(elapsedHours: 10)
    #expect(night.within6h.point > 0)
    #expect(CodexResetForecast.minHourMultiplier > 0)
}

@Test func workingHoursIsTheBandTheRecordActuallyLandsIn() {
    func at(_ iso: String) -> Date { CodexResetForecast.parseISO(iso)! }
    #expect(CodexResetForecast.isWorkingHoursSF(at("2026-06-15T20:00:00Z")))        // 13:00 PT
    #expect(!CodexResetForecast.isWorkingHoursSF(at("2026-06-15T11:00:00Z")))       // 04:00 PT
    #expect(!CodexResetForecast.isWorkingHoursSF(at("2026-06-15T13:00:00Z")))       // 06:00 PT
    #expect(CodexResetForecast.isWorkingHoursSF(at("2026-06-15T14:00:00Z")))        // 07:00 PT
    #expect(!CodexResetForecast.isWorkingHoursSF(at("2026-06-16T06:00:00Z")))       // 23:00 PT
}

// MARK: - This machine's own resets

@Test func withNoLocalEventsTheForecastUsesTheGlobalRecord() {
    let reading = Fixture.reading(elapsedHours: 40)
    #expect(reading.lastResetSource == .global)
    #expect(abs(reading.hoursSinceLastReset - 40) < 1e-6)
}

@Test func aMoreRecentLocalResetIsPreferredOverTheGlobalRecord() {
    let now = Fixture.last.addingTimeInterval(40 * 3600)
    let local = [CodexResetForecast.LocalResetEvent(at: Fixture.last.addingTimeInterval(36 * 3600), origin: .localEarlyReset)]
    guard case let .available(reading) = CodexResetForecast.evaluate(history: Fixture.standard, now: now, localEvents: local) else {
        Issue.record("expected a forecast"); return
    }
    #expect(reading.lastResetSource == .local)
    #expect(abs(reading.hoursSinceLastReset - 4) < 1e-6)
    #expect(CodexResetForecastPresentation.lines(for: .available(reading))[0]
        .contains("since the reset observed on this machine at "))
}

@Test func aLocalResetOlderThanTheGlobalRecordIsIgnored() {
    let now = Fixture.last.addingTimeInterval(40 * 3600)
    let local = [CodexResetForecast.LocalResetEvent(at: Fixture.last.addingTimeInterval(-10 * 3600), origin: .bankedCredit)]
    guard case let .available(reading) = CodexResetForecast.evaluate(history: Fixture.standard, now: now, localEvents: local) else {
        Issue.record("expected a forecast"); return
    }
    #expect(reading.lastResetSource == .global)
}

@Test func aLocalResetDatedInTheFutureIsIgnoredRatherThanGivingANegativeWait() {
    let now = Fixture.last.addingTimeInterval(40 * 3600)
    let local = [CodexResetForecast.LocalResetEvent(at: now.addingTimeInterval(86_400), origin: .localEarlyReset)]
    guard case let .available(reading) = CodexResetForecast.evaluate(history: Fixture.standard, now: now, localEvents: local) else {
        Issue.record("expected a forecast"); return
    }
    #expect(reading.lastResetSource == .global)
    #expect(reading.hoursSinceLastReset > 0)
}

// MARK: - Wording, and parity with the TypeScript module

@Test func theSentenceMatchesTheTypeScriptModuleCharacterForCharacter() {
    let lines = CodexResetForecastPresentation.lines(for: .available(Fixture.reading(elapsedHours: 12)))
    #expect(lines == [
        "Reset forecast: 6% chance in the next 24h (0 to 13%), 0% in 6h (0 to 1%). 12h since the last global reset; typical wait 2.0d. Working hours in SF: yes.",
        "Estimated from 30 past resets in the public record; moderate confidence.",
    ])
}

@Test func theCappedSentenceMatchesTheTypeScriptModule() {
    let lines = CodexResetForecastPresentation.lines(for: .available(Fixture.reading(elapsedHours: 44)))
    #expect(lines == [
        "Reset forecast: 99% chance in the next 24h (99 to 99%), 99% in 6h (99 to 99%). 44h since the last global reset; typical wait 2.0d. Working hours in SF: no.",
        "Estimated from 30 past resets in the public record; moderate confidence.",
    ])
}

@Test func theBeyondRecordSentenceMatchesTheTypeScriptModule() {
    let lines = CodexResetForecastPresentation.lines(for: .available(Fixture.reading(elapsedHours: 400)))
    #expect(lines == [
        "Reset forecast: 42% chance in the next 24h (0 to 100%), 1% in 6h (0 to 100%). 16.7d since the last global reset; typical wait 2.0d. Working hours in SF: no.",
        "Estimated from 30 past resets in the public record; the wait is already longer than any in that record; the record is 16 days old and out of date; low confidence.",
    ])
}

@Test func everyProbabilityIsPrintedWithARange() {
    let line = CodexResetForecastPresentation.lines(for: .available(Fixture.reading(elapsedHours: 12)))[0]
    // Two point estimates, and a parenthesised "low to high%" beside each.
    #expect(line.components(separatedBy: " to ").count - 1 == 2)
    #expect(line.components(separatedBy: "%)").count - 1 == 2)
    #expect(line.components(separatedBy: "%").count - 1 == 4)
}

@Test func theWordingSaysChanceAndNeverExpectedOrWill() {
    for elapsed in [3.0, 12, 44, 400] {
        for line in CodexResetForecastPresentation.lines(for: .available(Fixture.reading(elapsedHours: elapsed))) {
            #expect(!line.lowercased().contains("expect"))
            #expect(!line.lowercased().contains("will "))
            #expect(!line.lowercased().contains("guarantee"))
        }
        #expect(CodexResetForecastPresentation.lines(for: .available(Fixture.reading(elapsedHours: elapsed)))[0].contains("chance"))
    }
}

@Test func anUnavailableForecastRendersAsAReasonNotAZero() {
    let lines = CodexResetForecastPresentation.lines(for: CodexResetForecast.evaluate(history: Fixture.history([]), now: Fixture.last))
    #expect(lines.count == 1)
    #expect(lines[0].hasPrefix("Reset forecast: unavailable."))
    #expect(!lines[0].contains("0%"))
}

@Test func theFormattersMatchTheTypeScriptRules() {
    #expect(CodexResetForecastPresentation.percent(0.244) == "24%")
    #expect(CodexResetForecastPresentation.percent(2) == "100%")
    #expect(CodexResetForecastPresentation.percent(.nan) == "0%")
    #expect(CodexResetForecastPresentation.range(.init(point: 0.24, low: 0.1, high: 0.51)) == "(10 to 51%)")
    #expect(CodexResetForecastPresentation.duration(hours: 0.25) == "15m")
    #expect(CodexResetForecastPresentation.duration(hours: 0.001) == "1m")
    #expect(CodexResetForecastPresentation.duration(hours: 12) == "12h")
    #expect(CodexResetForecastPresentation.duration(hours: 47.4) == "47h")
    #expect(CodexResetForecastPresentation.duration(hours: 52.8) == "2.2d")
    #expect(CodexResetForecastPresentation.duration(hours: -1) == "0m")
}

// MARK: - The backtest that earns the confidence label

@Test func theBacktestScoresTheCadenceFixtureWalkForward() {
    let result = CodexResetForecast.backtest(history: Fixture.standard)
    #expect(result.probes > 0)
    #expect(result.modelBrier < result.baseRateBrier)
    #expect(result.beatsBaseRate)
    #expect(Fixture.reading(elapsedHours: 12).confidence == .moderate)
}

@Test func aRecordTooSmallToMeanAnythingEarnsNoLabelEvenWhenItScoresWell() {
    // Thirteen resets produce twelve waits, under `minWaitsForConfidence`. The
    // backtest walks forward over them and wins handsomely on a perfect
    // cadence; the label still has to stay low, because twelve waits is not a
    // sample you can promise anything from.
    let times = Fixture.times(count: 13)
    let history = Fixture.history(times)
    let result = CodexResetForecast.backtest(history: history)
    #expect(result.probes > 0)
    #expect(result.beatsBaseRate)
    guard case let .available(reading) = CodexResetForecast.evaluate(
        history: history, now: times[12].addingTimeInterval(12 * 3600)
    ) else { Issue.record("expected a forecast"); return }
    #expect(reading.waitCount < CodexResetForecast.minWaitsForConfidence)
    #expect(reading.confidence == .low)
}

@Test func aRecordTooShortToValidateEarnsNothing() {
    let short = Fixture.history(Fixture.times(count: 6))
    #expect(CodexResetForecast.backtest(history: short).probes == 0)
    #expect(!CodexResetForecast.backtest(history: short).beatsBaseRate)
}

@Test func aStaleRecordIsNeverLabelledModerateHoweverWellItScores() {
    // Stale but well inside the record's own waits, so the label is being
    // withheld for staleness alone and not because the wait ran off the end.
    let history = Fixture.history(Fixture.times(), generatedAt: Fixture.last.addingTimeInterval(-20 * 86_400))
    guard case let .available(reading) = CodexResetForecast.evaluate(
        history: history, now: Fixture.last.addingTimeInterval(12 * 3600)
    ) else { Issue.record("expected a forecast"); return }
    #expect(reading.stale)
    #expect(reading.beyondRecord == false)
    #expect(CodexResetForecast.backtest(history: history).beatsBaseRate)
    #expect(reading.confidence == .low)
}

@Test func theBundledRecordDecodesAndCarriesEnoughResets() {
    // The resource itself, as the shipped app reads it. A build that loses the
    // dataset shows "unavailable", and this is what notices.
    guard let bundled = CodexResetForecast.bundled else {
        Issue.record("the bundled reset history did not load"); return
    }
    #expect(bundled.source == "https://codex-reset.com/api/timeline")
    #expect(CodexResetForecast.resetInstants(bundled).count >= 40)
}

// MARK: - The opt-in notification

private func alertReading(_ within6h: Double, lastResetAt: Date = Fixture.last, stale: Bool = false, beyond: Bool = false) -> CodexResetForecast.Reading {
    CodexResetForecast.Reading(
        stale: stale,
        datasetAgeDays: 1,
        datasetGeneratedAt: Fixture.last,
        source: "https://codex-reset.com/api/timeline",
        resetCount: 30,
        waitCount: 29,
        lastResetAt: lastResetAt,
        lastResetSource: .global,
        hoursSinceLastReset: 40,
        typicalWaitHours: 48,
        within6h: .init(point: within6h, low: max(0, within6h - 0.15), high: min(1, within6h + 0.15)),
        within24h: .init(point: min(0.99, within6h + 0.2), low: within6h, high: 0.99),
        sanFranciscoHour: 14,
        workingHoursSF: true,
        beyondRecord: beyond,
        confidence: .low
    )
}

private func evaluate(
    _ within6h: Double,
    state: CodexResetForecastAlertState,
    threshold: Double = 0.5,
    lastResetAt: Date = Fixture.last,
    stale: Bool = false,
    beyond: Bool = false
) -> CodexResetForecastCrossingDetector.Outcome {
    CodexResetForecastCrossingDetector.evaluate(
        reading: alertReading(within6h, lastResetAt: lastResetAt, stale: stale, beyond: beyond),
        state: state,
        threshold: threshold,
        now: Fixture.last
    )
}

@Test func theNotificationIsOffByDefault() {
    let defaults = UserDefaults(suiteName: "codeburn.tests.resetForecast.default")!
    defaults.removePersistentDomain(forName: "codeburn.tests.resetForecast.default")
    #expect(CodexResetForecastNotificationPreference.isEnabled(defaults: defaults) == false)
    #expect(CodexResetForecastThresholdPreference.value(defaults: defaults) == 0.5)
}

@Test func anOutOfRangeStoredThresholdFallsBackToTheDefault() {
    let defaults = UserDefaults(suiteName: "codeburn.tests.resetForecast.threshold")!
    defaults.removePersistentDomain(forName: "codeburn.tests.resetForecast.threshold")
    for bad in [0.0, -1.0, 1.5, Double.nan] {
        defaults.set(bad, forKey: CodexResetForecastThresholdPreference.defaultsKey)
        #expect(CodexResetForecastThresholdPreference.value(defaults: defaults) == 0.5)
    }
}

@Test func itFiresOnceWhenTheChanceCrossesTheThreshold() {
    let first = evaluate(0.62, state: CodexResetForecastAlertState())
    #expect(first.fire != nil)
    #expect(first.state.armed == false)
}

@Test func itStaysSilentWhileTheChanceRemainsAboveTheThreshold() {
    let first = evaluate(0.62, state: CodexResetForecastAlertState())
    let second = evaluate(0.71, state: first.state)
    let third = evaluate(0.99, state: second.state)
    #expect(second.fire == nil)
    #expect(third.fire == nil)
}

@Test func itReArmsOnlyAfterTheChanceDropsBackUnderTheThreshold() {
    let fired = evaluate(0.62, state: CodexResetForecastAlertState())
    let stillHigh = evaluate(0.55, state: fired.state)
    #expect(stillHigh.state.armed == false)
    let dropped = evaluate(0.49, state: stillHigh.state)
    #expect(dropped.fire == nil)
    #expect(dropped.state.armed)
    #expect(evaluate(0.60, state: dropped.state).fire != nil)
}

@Test func aChanceExactlyAtTheThresholdFires() {
    #expect(evaluate(0.5, state: CodexResetForecastAlertState(), threshold: 0.5).fire != nil)
}

@Test func aFiredStateSurvivesTheRoundTripThroughDiskSoARelaunchDoesNotRepeat() throws {
    let fired = evaluate(0.62, state: CodexResetForecastAlertState()).state
    let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
    let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
    let restored = try decoder.decode(CodexResetForecastAlertState.self, from: encoder.encode(fired))
    #expect(restored == fired)
    #expect(evaluate(0.62, state: restored).fire == nil)
}

@Test func aNewResetReArmsBecauseTheNextCrossingBelongsToANewWait() {
    let fired = evaluate(0.62, state: CodexResetForecastAlertState())
    let afterReset = evaluate(0.62, state: fired.state, lastResetAt: Fixture.last.addingTimeInterval(48 * 3600))
    #expect(afterReset.fire != nil)
}

@Test func loweringTheThresholdReArmsRatherThanSilencingForever() {
    let fired = evaluate(0.62, state: CodexResetForecastAlertState(), threshold: 0.75)
    #expect(fired.fire == nil)                       // 0.62 is under 0.75
    let atFifty = evaluate(0.62, state: fired.state, threshold: 0.5)
    #expect(atFifty.fire != nil)
    let raised = evaluate(0.62, state: atFifty.state, threshold: 0.6)
    #expect(raised.fire != nil)                      // a moved threshold is a new question
}

@Test func aFailedRefreshIsNoOpinionAndCannotReArm() {
    let fired = evaluate(0.62, state: CodexResetForecastAlertState())
    let silent = CodexResetForecastCrossingDetector.evaluate(
        reading: nil, state: fired.state, threshold: 0.5, now: Fixture.last
    )
    #expect(silent.fire == nil)
    #expect(silent.state == fired.state)
    #expect(evaluate(0.62, state: silent.state).fire == nil)
}

@Test func aStaleRecordNeverWakesAnyone() {
    #expect(evaluate(0.9, state: CodexResetForecastAlertState(), stale: true).fire == nil)
}

@Test func anEstimatePastTheEndOfTheRecordNeverWakesAnyone() {
    // Its range is 0 to 100%; a notice built on that would be noise.
    #expect(evaluate(0.9, state: CodexResetForecastAlertState(), beyond: true).fire == nil)
}

@Test func aBrokenThresholdNeverFires() {
    for bad in [0.0, -0.2, 1.4] {
        #expect(evaluate(0.99, state: CodexResetForecastAlertState(), threshold: bad).fire == nil)
    }
}

@Test func theNoticeSaysWhatItIsBeforeItSaysANumberAndAsksForNothing() {
    let copy = CodexResetForecastPresentation.notice(for: alertReading(0.62))
    #expect(copy.title == "Codex reset forecast")
    #expect(copy.body.hasPrefix("A statistical estimate from public reset history, not an announcement from OpenAI."))
    #expect(copy.body.contains("62% chance (47 to 77%)"))
    #expect(copy.body.contains("Nothing has reset yet and nothing was changed."))
    // Never an instruction, never a promise.
    #expect(!copy.body.lowercased().contains("will "))
    #expect(!copy.body.lowercased().contains("expect"))
    #expect(!copy.body.lowercased().contains("tap"))
    #expect(!copy.body.lowercased().contains("click"))
}

// MARK: - Local events, read off the sibling features' stores
//
// The JSON below is the verbatim output of those two branches' own encoders.
// It was produced by compiling `EarlyQuotaResetReading`/`EarlyQuotaResetEvent`
// from `feat/early-quota-reset`'s `EarlyQuotaReset.swift` and the
// `ProviderState` declaration from its `EarlyQuotaResetMonitor.swift`, and
// `CodexBankedResetState` from `feat/codex-banked-resets`'s
// `CodexBankedResets.swift`, then encoding with the same `JSONEncoder` settings
// each branch's store uses (`.secondsSince1970` for #1320's `UserDefaults`
// record, `.iso8601` for #1322's `codex-banked-resets.json`). Neither type is
// imported: this branch reads these records, it does not depend on them.

private enum LocalEventFixture {
    /// detectedAt 1757687400 = 2026-09-12T14:30:00Z
    static let codexEarlyReset = """
    {
      "announced" : { "primary" : [ 1757692800 ] },
      "latestEvent" : {
        "detectedAt" : 1757687400,
        "percentAfter" : 2,
        "percentBefore" : 88,
        "providerID" : "codex",
        "providerName" : "Codex",
        "scheduledResetAt" : 1757692800,
        "signal" : "usageDropped",
        "windowKey" : "primary",
        "windowName" : "5-hour limit"
      },
      "planLabel" : "Pro",
      "windows" : { "primary" : { "observedAt" : 1757687400, "percent" : 2, "resetsAt" : 1757705400 } }
    }
    """

    /// The same record for Anthropic. Must never move the Codex clock.
    static let claudeEarlyReset = """
    {
      "announced" : { "seven_day" : [ 1757779200 ] },
      "latestEvent" : {
        "detectedAt" : 1757773800,
        "percentAfter" : 0,
        "percentBefore" : 74,
        "providerID" : "claude",
        "providerName" : "Claude",
        "scheduledResetAt" : 1757779200,
        "signal" : "resetMovedForward",
        "windowKey" : "seven_day",
        "windowName" : "weekly limit"
      },
      "planLabel" : "Max 20x",
      "windows" : { "seven_day" : { "observedAt" : 1757687400, "percent" : 2, "resetsAt" : 1757705400 } }
    }
    """

    /// A first observation: state, but no event yet.
    static let baselineOnly = """
    {
      "announced" : { },
      "planLabel" : "Pro",
      "windows" : { "primary" : { "observedAt" : 1757687400, "percent" : 2, "resetsAt" : 1757705400 } }
    }
    """

    /// firstSeenAt 1757600000 and 1757690000.
    static let bankedCredits = """
    {
      "baselineAt" : "2025-09-04T15:33:20Z",
      "credits" : [
        { "firstSeenAt" : "2025-09-11T14:13:20Z", "id" : "credit-a" },
        { "firstSeenAt" : "2025-09-12T15:13:20Z", "id" : "credit-b" }
      ]
    }
    """

    static let detectedAt = Date(timeIntervalSince1970: 1_757_687_400)
    static let newestCredit = Date(timeIntervalSince1970: 1_757_690_000)
}

/// An isolated defaults suite and an empty cache directory per test, so nothing
/// here can read or write the developer's real state.
private struct LocalEventSandbox {
    let defaults: UserDefaults
    let cacheDir: String
    private let suite: String

    init(_ name: String) {
        suite = "codeburn.tests.localEvents.\(name)"
        defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        cacheDir = NSTemporaryDirectory() + "codeburn-local-events-\(name)-\(UUID().uuidString)"
        try? FileManager.default.createDirectory(atPath: cacheDir, withIntermediateDirectories: true)
    }

    func writeEarlyReset(_ json: String, providerID: String) {
        defaults.set(Data(json.utf8), forKey: CodexResetForecastLocalEvents.earlyResetDefaultsKeyPrefix + providerID)
    }

    func writeBanked(_ json: String) {
        try? Data(json.utf8).write(to: URL(fileURLWithPath:
            (cacheDir as NSString).appendingPathComponent(CodexResetForecastLocalEvents.bankedResetFilename)))
    }

    func load() -> [CodexResetForecast.LocalResetEvent] {
        CodexResetForecastLocalEvents.load(cacheDir: cacheDir, defaults: defaults)
    }
}

@MainActor
@Test func theLoaderReadsTheExactStoresTheSiblingFeaturesWriteTo() {
    // Literal, not symbolic: a typo in either address means the loader silently
    // reads nothing and the last-reset clock quietly goes back to being frozen
    // at the last release, with no error anywhere. These two strings are copied
    // from `EarlyQuotaResetMonitor.defaultsKeyPrefix` on feat/early-quota-reset
    // and `bankedResetFilename` in feat/codex-banked-resets.
    // `EarlyQuotaResetMonitor` is @MainActor, so its static cannot initialise a
    // nonisolated one; this is what keeps the two from drifting instead.
    #expect(CodexResetForecastLocalEvents.earlyResetDefaultsKeyPrefix == EarlyQuotaResetMonitor.defaultsKeyPrefix)
    #expect(CodexResetForecastLocalEvents.earlyResetDefaultsKeyPrefix == "codeburn.quota.earlyReset.state.")
    #expect(CodexResetForecastLocalEvents.bankedResetFilename == "codex-banked-resets.json")
}

@Test func theLoaderUsesTheCodexProviderIdTheRestOfTheAppUses() {
    #expect(CodexResetForecastLocalEvents.codexProviderID == CapacityDockProvider.codex.rawValue)
}

@Test func withNeitherStorePresentTheLoaderReturnsNothing() {
    #expect(LocalEventSandbox("absent").load().isEmpty)
}

@Test func aCodexEarlyResetBecomesALocalEventAtItsDetectionTime() {
    let sandbox = LocalEventSandbox("early")
    sandbox.writeEarlyReset(LocalEventFixture.codexEarlyReset, providerID: "codex")
    let events = sandbox.load()
    #expect(events.count == 1)
    #expect(events.first?.origin == .localEarlyReset)
    // detectedAt, not scheduledResetAt: the latter is when the cut-short cycle
    // would have reset, which is in the future and is not when anything happened.
    #expect(events.first?.at == LocalEventFixture.detectedAt)
}

@Test func anAnthropicEarlyResetNeverMovesTheCodexClock() {
    let sandbox = LocalEventSandbox("claude")
    // Both the wrong key and, belt and braces, the right key holding a record
    // that names another provider.
    sandbox.writeEarlyReset(LocalEventFixture.claudeEarlyReset, providerID: "claude")
    #expect(sandbox.load().isEmpty)
    sandbox.writeEarlyReset(LocalEventFixture.claudeEarlyReset, providerID: "codex")
    #expect(sandbox.load().isEmpty)
}

@Test func aFirstObservationWithNoEventYetIsNoOpinion() {
    let sandbox = LocalEventSandbox("baseline")
    sandbox.writeEarlyReset(LocalEventFixture.baselineOnly, providerID: "codex")
    #expect(sandbox.load().isEmpty)
}

@Test func bankedCreditsBecomeLocalEventsAtTheirFirstSeenTime() {
    let sandbox = LocalEventSandbox("banked")
    sandbox.writeBanked(LocalEventFixture.bankedCredits)
    let events = sandbox.load()
    #expect(events.count == 2)
    #expect(events.allSatisfy { $0.origin == .bankedCredit })
    #expect(events.map(\.at).max() == LocalEventFixture.newestCredit)
}

@Test func aMalformedStoreIsNoOpinionRatherThanAnError() {
    for junk in ["", "{", "null", "[]", "{\"latestEvent\":\"nope\"}", "{\"credits\":\"nope\"}"] {
        let sandbox = LocalEventSandbox("junk\(abs(junk.hashValue))")
        sandbox.writeEarlyReset(junk, providerID: "codex")
        sandbox.writeBanked(junk)
        #expect(sandbox.load().isEmpty)
    }
}

@Test func aStoreCarryingUnknownFieldsStillDecodes() {
    // A newer version of either feature adding fields must not blind this
    // loader: `Decodable` ignores keys it does not know.
    let sandbox = LocalEventSandbox("forward")
    sandbox.writeEarlyReset("""
    {"announced":{},"windows":{},"planLabel":"Pro","schemaVersion":9,
     "latestEvent":{"providerID":"codex","providerName":"Codex","windowKey":"primary",
       "windowName":"5-hour limit","signal":"usageDropped","scheduledResetAt":1757692800,
       "detectedAt":1757687400,"percentBefore":88,"percentAfter":2,"newField":"x"}}
    """, providerID: "codex")
    sandbox.writeBanked("""
    {"baselineAt":"2025-09-04T15:33:20Z","extra":1,
     "credits":[{"id":"c","firstSeenAt":"2025-09-12T15:13:20Z","note":"x"}]}
    """)
    #expect(sandbox.load().count == 2)
}

@Test func aRecordMissingFieldsTheirTypesRequireIsNoOpinion() {
    // The trade for decoding through their real types rather than through
    // mirrors: a record that does not satisfy their shape is read as nothing at
    // all, which is the safe direction. Drift becomes a compile error instead of
    // a silent misread.
    let sandbox = LocalEventSandbox("partial")
    sandbox.writeEarlyReset(#"{"latestEvent":{"providerID":"codex","detectedAt":1757687400}}"#, providerID: "codex")
    sandbox.writeBanked(#"{"credits":[{"id":"c"}]}"#)
    #expect(sandbox.load().isEmpty)
}

@Test func aLocalResetNewerThanTheRecordMovesTheClockAndTheSentence() {
    let times = Fixture.times()
    let now = times[times.count - 1].addingTimeInterval(40 * 3600)
    let local = [CodexResetForecast.LocalResetEvent(
        at: times[times.count - 1].addingTimeInterval(36 * 3600), origin: .localEarlyReset
    )]
    guard case let .available(reading) = CodexResetForecast.evaluate(
        history: Fixture.standard, now: now, localEvents: local
    ) else { Issue.record("expected a forecast"); return }
    #expect(reading.lastResetSource == .local)
    #expect(abs(reading.hoursSinceLastReset - 4) < 1e-6)
    let expected = "since the reset observed on this machine at "
        + CodexResetForecastPresentation.localClock(local[0].at)
    #expect(CodexResetForecastPresentation.lines(for: .available(reading))[0].contains(expected))
}

@Test func aLocalResetOlderThanTheRecordLeavesTheSentenceGlobal() {
    let times = Fixture.times()
    let now = times[times.count - 1].addingTimeInterval(40 * 3600)
    let local = [CodexResetForecast.LocalResetEvent(
        at: times[times.count - 1].addingTimeInterval(-10 * 3600), origin: .bankedCredit
    )]
    guard case let .available(reading) = CodexResetForecast.evaluate(
        history: Fixture.standard, now: now, localEvents: local
    ) else { Issue.record("expected a forecast"); return }
    #expect(reading.lastResetSource == .global)
    #expect(CodexResetForecastPresentation.lines(for: .available(reading))[0]
        .contains("since the last global reset"))
}

@Test func theLocalClockIsZeroPadded() {
    var components = DateComponents()
    components.year = 2026; components.month = 9; components.day = 12
    components.hour = 4; components.minute = 5
    let early = Calendar.current.date(from: components)!
    #expect(CodexResetForecastPresentation.localClock(early) == "04:05")
    components.hour = 14; components.minute = 30
    #expect(CodexResetForecastPresentation.localClock(Calendar.current.date(from: components)!) == "14:30")
}

// MARK: - The hourly, first-party reset-history refresh

private func historyJSON(generatedAt: String, resets: Int = 3, extraField: Bool = false, scrambled: Bool = false) -> Data {
    var rows: [String] = []
    for index in 0..<resets {
        let day = scrambled && index == 1 ? "2020-01-01" : String(format: "2026-01-%02d", index + 1)
        let extra = extraField && index == 0 ? ",\"text\":\"Resetting limits for everyone!\"" : ""
        rows.append("{\"id\":\"r\(index)\",\"announced_at\":\"\(day)T00:00:00Z\",\"type\":\"reset\",\"reset_kind\":\"global\"\(extra)}")
    }
    let json = "{\"schema\":1,\"source\":\"https://codex-reset.com/api/timeline\","
        + "\"generated_at\":\"\(generatedAt)\",\"events\":[\(rows.joined(separator: ","))]}"
    return Data(json.utf8)
}

private func decodedHistory(_ generatedAt: String, resets: Int = 3) -> CodexResetForecast.History {
    CodexResetForecast.validated(rawJSON: historyJSON(generatedAt: generatedAt, resets: resets))!
}

private let fetchNow = Date(timeIntervalSince1970: 1_757_764_800)
private let bundledRecord = decodedHistory("2026-09-01T00:00:00Z")
private let newerRecord = decodedHistory("2026-09-13T11:30:00Z", resets: 4)

@Test func theFetchTargetsTheOneHostTheAppAlreadyContacts() {
    // UpdateChecker already talks to api.github.com. raw.githubusercontent.com
    // would have been a host this app has never used.
    #expect(CodexResetHistoryPolicy.host == "api.github.com")
    let url = CodexResetHistoryPolicy.url.absoluteString
    #expect(url.contains("ref=data/codex-reset-history"))
    #expect(!url.contains("codex-reset.com"))
    #expect(!url.contains("raw.githubusercontent.com"))
}

@Test func theFetchIsDueOnlyOnceAnHour() {
    #expect(CodexResetHistoryPolicy.isDue(cache: nil, now: fetchNow))
    let justTried = CodexResetHistoryCache(attemptedAt: fetchNow, etag: nil, document: nil)
    #expect(!CodexResetHistoryPolicy.isDue(cache: justTried, now: fetchNow.addingTimeInterval(3599)))
    #expect(CodexResetHistoryPolicy.isDue(cache: justTried, now: fetchNow.addingTimeInterval(3600)))
}

@Test func aNewerRecordIsAdoptedAndItsETagKept() {
    let next = CodexResetHistoryPolicy.apply(
        status: 200, body: historyJSON(generatedAt: "2026-09-13T11:30:00Z", resets: 4),
        etag: "W/\"abc\"", retryAfterSeconds: nil, cache: nil, bundled: bundledRecord, now: fetchNow
    )
    #expect(next.document?.generatedAt == "2026-09-13T11:30:00Z")
    #expect(next.etag == "W/\"abc\"")
    #expect(CodexResetHistoryPolicy.resolve(bundled: bundledRecord, cached: next.document).source == .fetched)
}

@Test func aThreeOhFourKeepsWhatIsHeldAndRestartsTheClock() {
    let held = CodexResetHistoryCache(attemptedAt: fetchNow.addingTimeInterval(-7200), etag: "W/\"abc\"", document: newerRecord)
    let next = CodexResetHistoryPolicy.apply(
        status: 304, body: Data(), etag: nil, retryAfterSeconds: nil,
        cache: held, bundled: bundledRecord, now: fetchNow
    )
    #expect(next.document == newerRecord)
    #expect(next.etag == "W/\"abc\"")
    #expect(next.attemptedAt == fetchNow)
}

@Test func aThreeOhFourBodyIsNeverRead() {
    // A proxy or a misconfigured cache can answer 304 with a body anyway.
    // "Unchanged" has to mean unchanged.
    let held = CodexResetHistoryCache(attemptedAt: fetchNow.addingTimeInterval(-7200), etag: nil, document: newerRecord)
    let next = CodexResetHistoryPolicy.apply(
        status: 304, body: historyJSON(generatedAt: "2027-01-01T00:00:00Z", resets: 5),
        etag: nil, retryAfterSeconds: nil, cache: held, bundled: bundledRecord, now: fetchNow
    )
    #expect(next.document == newerRecord)
}

@Test func theBundledRecordWinsATie() {
    let sameAge = CodexResetForecast.validated(rawJSON: historyJSON(generatedAt: bundledRecord.generatedAt, resets: 7))
    #expect(CodexResetHistoryPolicy.resolve(bundled: bundledRecord, cached: sameAge).source == .bundled)
}

@Test func theValidatorRefusesAnotherSchemaAndACreditWearingAResetKind() {
    let twoResets = "{\"id\":\"a\",\"announced_at\":\"2026-01-01T00:00:00Z\",\"type\":\"reset\",\"reset_kind\":\"global\"},"
        + "{\"id\":\"b\",\"announced_at\":\"2026-01-02T00:00:00Z\",\"type\":\"reset\",\"reset_kind\":\"global\"}"
    let otherSchema = "{\"schema\":2,\"source\":\"s\",\"generated_at\":\"2026-09-13T11:30:00Z\",\"events\":[\(twoResets)]}"
    #expect(CodexResetForecast.validated(rawJSON: Data(otherSchema.utf8)) == nil)

    let credit = ",{\"id\":\"c\",\"announced_at\":\"2026-01-03T00:00:00Z\",\"type\":\"credits\",\"reset_kind\":\"global\"}"
    let creditWithKind = "{\"schema\":1,\"source\":\"s\",\"generated_at\":\"2026-09-13T11:30:00Z\",\"events\":[\(twoResets)\(credit)]}"
    #expect(CodexResetForecast.validated(rawJSON: Data(creditWithKind.utf8)) == nil)
}

@Test func anOlderOrEqualRecordIsNotAnUpdate() {
    for generatedAt in ["2026-08-01T00:00:00Z", bundledRecord.generatedAt] {
        let next = CodexResetHistoryPolicy.apply(
            status: 200, body: historyJSON(generatedAt: generatedAt, resets: 9),
            etag: nil, retryAfterSeconds: nil, cache: nil, bundled: bundledRecord, now: fetchNow
        )
        #expect(next.document == nil)
        #expect(CodexResetHistoryPolicy.resolve(bundled: bundledRecord, cached: next.document).source == .bundled)
    }
}

@Test func aMalformedOrDishonestRecordIsRejected() {
    let bodies: [Data] = [
        Data(), Data("not json".utf8), Data("{}".utf8), Data("[]".utf8),
        // Carries post text: the rule that matters most, and the one a decoder
        // would have silently dropped.
        historyJSON(generatedAt: "2026-09-13T11:30:00Z", extraField: true),
        // Timestamps go backwards.
        historyJSON(generatedAt: "2026-09-13T11:30:00Z", resets: 4, scrambled: true),
        // Not enough resets to be an improvement on anything.
        historyJSON(generatedAt: "2026-09-13T11:30:00Z", resets: 1),
    ]
    for body in bodies {
        #expect(CodexResetForecast.validated(rawJSON: body) == nil)
        let next = CodexResetHistoryPolicy.apply(
            status: 200, body: body, etag: "W/\"x\"", retryAfterSeconds: nil,
            cache: nil, bundled: bundledRecord, now: fetchNow
        )
        #expect(next.document == nil)
    }
}

@Test func aRefusalOrAnErrorLeavesTheRecordAlone() {
    let held = CodexResetHistoryCache(attemptedAt: fetchNow.addingTimeInterval(-7200), etag: "W/\"abc\"", document: newerRecord)
    for status in [403, 404, 500, 0] {
        let next = CodexResetHistoryPolicy.apply(
            status: status, body: Data(), etag: nil, retryAfterSeconds: nil,
            cache: held, bundled: bundledRecord, now: fetchNow
        )
        #expect(next.document == newerRecord)
    }
}

@Test func retryAfterPushesTheNextAttemptOutRatherThanSleeping() {
    let next = CodexResetHistoryPolicy.apply(
        status: 403, body: Data(), etag: nil, retryAfterSeconds: 7200,
        cache: nil, bundled: bundledRecord, now: fetchNow
    )
    // An hour later is still too early; two hours later is not.
    #expect(!CodexResetHistoryPolicy.isDue(cache: next, now: fetchNow.addingTimeInterval(3600)))
    #expect(CodexResetHistoryPolicy.isDue(cache: next, now: fetchNow.addingTimeInterval(7201)))
}

@Test func withNothingFetchedTheForecastReadsTheBundledRecord() {
    let resolution = CodexResetHistoryPolicy.resolve(bundled: bundledRecord, cached: nil)
    #expect(resolution.source == .bundled)
    #expect(resolution.history == bundledRecord)
}

@Test func theRefreshIsOnByDefaultUnlikeTheNotification() {
    let defaults = UserDefaults(suiteName: "codeburn.tests.resetHistoryRefresh")!
    defaults.removePersistentDomain(forName: "codeburn.tests.resetHistoryRefresh")
    #expect(CodexResetHistoryRefreshPreference.isEnabled(defaults: defaults))
    #expect(CodexResetForecastNotificationPreference.isEnabled(defaults: defaults) == false)
}

/// A store that starts empty and records what it is asked to keep.
private actor RecordingCacheStore: CodexResetHistoryCacheStoring {
    private var held: CodexResetHistoryCache?
    private(set) var saves = 0
    init(_ initial: CodexResetHistoryCache? = nil) { held = initial }
    func load() async -> CodexResetHistoryCache? { held }
    func save(_ cache: CodexResetHistoryCache) async { held = cache; saves += 1 }
    func current() -> CodexResetHistoryCache? { held }
}

@Test func theSwitchBeingOffMeansNoRequestAndTheBundledRecord() async {
    var requests = 0
    let fetcher = CodexResetHistoryFetcher(store: RecordingCacheStore()) { _ in
        requests += 1
        return (Data(), URLResponse())
    }
    let resolution = await fetcher.refreshIfDue(bundled: bundledRecord, enabled: false, now: fetchNow)
    #expect(requests == 0)
    #expect(resolution.source == .bundled)
}

@Test func theRequestCarriesNothingAboutTheUser() async {
    var seen: URLRequest?
    let fetcher = CodexResetHistoryFetcher(store: RecordingCacheStore()) { request in
        seen = request
        return (Data(), HTTPURLResponse(url: request.url!, statusCode: 304, httpVersion: nil, headerFields: nil)!)
    }
    _ = await fetcher.refreshIfDue(bundled: bundledRecord, enabled: true, now: fetchNow)
    let headers = seen?.allHTTPHeaderFields ?? [:]
    #expect(Set(headers.keys) == ["Accept", "User-Agent"])
    #expect(headers["Accept"] == "application/vnd.github.raw+json")
    #expect(seen?.httpShouldHandleCookies == false)
    #expect(seen?.httpBody == nil)
}

@Test func aNetworkFailureIsRecordedAsAnAttemptAndNotRetriedImmediately() async {
    struct Offline: Error {}
    var requests = 0
    let store = RecordingCacheStore()
    let fetcher = CodexResetHistoryFetcher(store: store) { _ in
        requests += 1
        throw Offline()
    }
    let first = await fetcher.refreshIfDue(bundled: bundledRecord, enabled: true, now: fetchNow)
    #expect(first.source == .bundled)
    _ = await fetcher.refreshIfDue(bundled: bundledRecord, enabled: true, now: fetchNow.addingTimeInterval(60))
    #expect(requests == 1)
}
