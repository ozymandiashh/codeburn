import Foundation

/// Turns a quota window into the one-line pace caption the Capacity Dock's
/// window columns and the agent-tab quota hover card both draw (#1215): the
/// whole-window average interpretation `QuotaPace` defends (#726 phase 1),
/// rendered as "on pace", a deficit/reserve stage, an estimated exhaustion,
/// or the explicit exhausted state. Deliberately text-only: the math lives in
/// `QuotaPace`, the wording lives here, so both stay testable without a view.
///
/// Honesty rules this type enforces:
/// - The caption describes the AVERAGE pace across the whole elapsed window,
///   never a measured recent rate. The hover/accessibility text says so.
/// - Only validated window durations are used. A window without
///   `windowSeconds` gets no estimate — the label ("Weekly") is not a length.
/// - `Window.percent` is a 0...1 fraction; `QuotaPace` consumes 0...100.
///   This is the one place the unit crosses, and it is tested. Anything
///   outside 0...1 (negative, >1, NaN, infinity) is rejected, not clamped.
/// - A projection is valid only while the sample that produced the window is
///   inside `QuotaSummary`'s ten-minute freshness horizon. A connected
///   account can still carry an old loaded sample while a refresh is pending;
///   that sample must not become a forecast.
/// - The estimate is an ETA measured from `now` ("est. out in 3h 20m"), never
///   a lead before reset, and every countdown is computed against the passed
///   `now`, never a hidden wall clock, so fixtures stay deterministic.
/// - Stale, failed, loading or disconnected quota data gets nothing. A reset
///   in the past, or further out than one full window (clock/data skew), and
///   non-finite reset timestamps are refused before any branch.
enum QuotaPacePresentation {
    /// Claude's rate-limit windows are fixed lengths (the same values the
    /// plan popover projects with), so they are validated durations.
    static let claudeFiveHourSeconds = 5 * 3600
    static let claudeSevenDaySeconds = 7 * 24 * 3600

    /// Smallest share of a long window, in whole percent, the caption names as
    /// unused at the current pace.
    ///
    /// The share is `100 − projected`, and `projected` is a straight-line
    /// extrapolation of one whole-window average. At the precision a linear
    /// model has, a projection of 96% and one of 100% are the same forecast: a
    /// few heavy or quiet hours move the average by more than that, so "~4%
    /// unused" would promise a margin the model cannot see, and it would
    /// flicker in and out of the caption as the average drifts. Ten points is
    /// the smallest leftover that clears that noise and is still worth acting
    /// on (about 17 hours of a seven-day window). Below it the caption stays
    /// the plain verdict, and the projected figure stays in `helpText`.
    static let minimumUnusedSharePercent = 10

    /// What a window column draws in its reserved pace slot. The slot itself
    /// stays empty when no `Line` is defensible.
    struct Line: Equatable {
        enum Kind: Equatable {
            /// Projected from the whole-window average.
            case estimate
            /// The window is at exactly 100% and has not reset yet.
            case exhausted
        }

        /// Visual weight for the caption: muted for a healthy pace, amber for
        /// a deficit or projected overflow, red once the limit is reached.
        enum Tone: Equatable {
            case neutral
            case warning
            case danger
        }

        let kind: Kind
        let tone: Tone
        /// Compact caption for the column, e.g. "est. out in 3h 20m".
        let text: String
        /// Hover/accessibility text carrying the full honest reading.
        let helpText: String
    }

    /// The caption for one window, or nil when nothing defensible remains.
    static func line(
        for window: QuotaSummary.Window,
        connection: QuotaSummary.Connection,
        now: Date = Date()
    ) -> Line? {
        // Last-known or in-flight data cannot back a projection.
        guard connection == .connected else { return nil }
        // A connected summary can still be an old loaded sample while a
        // refresh is pending. Keep the pace caption honest by tying it to the
        // same injected `now` used by the calculation and by the tests.
        guard window.isFresh(at: now) else { return nil }
        guard let windowSeconds = window.windowSeconds, windowSeconds > 0 else { return nil }
        guard let resetsAt = window.resetsAt else { return nil }
        // `percent` arrives as a fraction; the pace math consumes percent.
        // Reject non-finite or out-of-range samples before either branch: a
        // negative fraction clamped to zero would invent a healthy forecast,
        // and >1 is not a "100% used" signal, it is a broken sample.
        guard window.percent.isFinite, window.percent >= 0, window.percent <= 1 else { return nil }
        let usedPercent = window.percent * 100

        // Reset in the past, or further out than one full window, or a
        // non-finite timestamp: clock/data skew. Guard both branches — an
        // "exhausted" window whose reset is months away is impossible data,
        // not a limit that is actually reached.
        let remaining = resetsAt.timeIntervalSince(now)
        guard remaining.isFinite else { return nil }
        guard remaining > 0, remaining <= TimeInterval(windowSeconds) else { return nil }

        if usedPercent >= 100 {
            return Line(
                kind: .exhausted,
                tone: .danger,
                text: L("Limit reached"),
                helpText: L(
                    "This window's limit is fully used. It resets in %@.",
                    countdownLabel(seconds: remaining)
                )
            )
        }

        guard let result = QuotaPace.evaluate(
            usedPercent: usedPercent,
            resetsAt: resetsAt,
            windowSeconds: windowSeconds,
            now: now
        ) else { return nil }
        let tone: Line.Tone = result.willOverflow || result.deltaPercent > 2 ? .warning : .neutral
        return Line(
            kind: .estimate,
            tone: tone,
            text: caption(for: result, windowSeconds: windowSeconds, now: now),
            helpText: helpText(
                result: result,
                windowSeconds: windowSeconds,
                now: now,
                resetsAt: resetsAt
            )
        )
    }

    /// One line per displayed window, in report order. Distinct scope windows
    /// that merely share a duration (Claude's Weekly vs Weekly · Opus vs
    /// Weekly · Sonnet, or Codex's extra per-model limits) each keep their own
    /// caption — they report different usage and different exhaustion risk.
    /// Only a genuinely identical duplicate window (same label, percent,
    /// reset and duration) is suppressed.
    static func lines(
        for windows: [QuotaSummary.Window],
        connection: QuotaSummary.Connection,
        now: Date = Date()
    ) -> [Line?] {
        var seen: [QuotaSummary.Window] = []
        return windows.map { window in
            guard !seen.contains(window) else { return nil }
            seen.append(window)
            return line(for: window, connection: connection, now: now)
        }
    }

    /// Whether the panel must reserve a pace slot under the window columns.
    /// Deliberately independent of both wall-clock time and connection state:
    /// the slot is reserved whenever a displayed window carries a validated
    /// duration and a reset date, even while the caption itself is empty (a
    /// window younger than 3%, a stale sample, a refresh in flight). Reserving
    /// on shape alone keeps the computed panel height from changing under the
    /// pointer every time a refresh or a freshness horizon flips the caption.
    static func reservesLine(for windows: [QuotaSummary.Window]) -> Bool {
        windows.contains { window in
            guard let seconds = window.windowSeconds, seconds > 0 else { return false }
            return window.resetsAt != nil
        }
    }

    /// The share of a long window this pace leaves unused at the reset, in
    /// whole percent, or nil when the caption must not name one.
    ///
    /// Nil on every window that is not the under-limit long-window case: a
    /// short window prints its deficit/reserve stage instead (#726), and an
    /// overflowing window leaves nothing unused to talk about. Nil inside the
    /// same two-point on-pace band the stage and the help text use: the
    /// leftover is the delta divided by the elapsed fraction, so early in a
    /// week a one-point gap would otherwise read as a double-digit share while
    /// the tooltip calls the same window on pace. Nil too below
    /// `minimumUnusedSharePercent`, applied to the *rounded* figure so the
    /// caption can never print a number the threshold says is too small.
    ///
    /// This is the complement of the projection `helpText` already carries,
    /// and of the Plan tab's "%@ at reset" wherever that caption runs the same
    /// `QuotaPace` math: 44% unused is 56% projected, one subtraction apart,
    /// never a second independent estimate.
    static func unusedSharePercent(for result: QuotaPace.Result, windowSeconds: Int) -> Int? {
        guard TimeInterval(windowSeconds) > QuotaPace.etaSuppressionMaxSeconds else { return nil }
        guard !result.willOverflow else { return nil }
        guard abs(result.deltaPercent) > 2 else { return nil }
        let unused = Int((100 - result.projectedPercent).rounded())
        guard unused >= minimumUnusedSharePercent else { return nil }
        return unused
    }

    /// Compact caption, phrased as the plain "am I going to make it?" answer
    /// #1287 argued for rather than as a projection the reader has to decode:
    /// a window that lands at or under the limit reads "Lasts until reset",
    /// one that does not reads "Runs out in <now-to-limit>". A long window that
    /// lasts with a material share to spare also says how much of the paid
    /// window that pace leaves on the table — "Lasts until reset · ~44%
    /// unused" — because "it lasts" alone hides the difference between
    /// finishing the week at 98% and finishing it at 56%. The verdict stays the
    /// lead, the share is an aside, and the "at this pace" the share is only
    /// true under stays in `helpText`, which is where the caption's 12pt slot
    /// ends (the two-column dock cell is 155pt wide, and the whole sentence
    /// does not fit at any scale the slot allows). The projected percentage it
    /// came from stays there too. On windows at or under
    /// `QuotaPace.etaSuppressionMaxSeconds` there is no defensible ETA at all
    /// — a linear read of a short window cries wolf after one burst — so
    /// those keep the on-pace / deficit / reserve stage instead (#726).
    static func caption(for result: QuotaPace.Result, windowSeconds: Int, now: Date = Date()) -> String {
        let compact = TimeInterval(windowSeconds) <= QuotaPace.etaSuppressionMaxSeconds
        if compact {
            if abs(result.deltaPercent) <= 2 { return L("On pace") }
            // Same two keys the Plan tab's stage caption uses, so a stage never
            // reads one way in the dock and another in the popover.
            if result.deltaPercent > 0 {
                return L("%@%% in deficit", String(Int(result.deltaPercent.rounded())))
            }
            return L("%@%% in reserve", String(Int(-result.deltaPercent.rounded())))
        }
        guard result.willOverflow else {
            guard let unused = unusedSharePercent(for: result, windowSeconds: windowSeconds) else {
                return L("Lasts until reset")
            }
            return L("Lasts until reset · ~%lld%% unused", unused)
        }
        // A long overflowing window always yields an ETA (a projection over
        // 100% implies a positive rate), but if that ever stopped holding,
        // saying it lasts would be the one wrong answer.
        guard let hitsLimitAt = result.hitsLimitAt else { return L("Won't last until reset") }
        return L("Runs out in %@", countdownLabel(from: now, to: hitsLimitAt))
    }

    private static func helpText(
        result: QuotaPace.Result,
        windowSeconds: Int,
        now: Date,
        resetsAt: Date
    ) -> String {
        let basis = L(
            "Estimated from the average pace across this whole %@ window so far — not a measured recent rate.",
            windowLengthLabel(seconds: windowSeconds)
        )
        let projected = Int(result.projectedPercent.rounded())
        let projectionSentence: String
        if result.willOverflow, let hitsLimitAt = result.hitsLimitAt {
            projectionSentence = L(
                "At that pace the limit is reached in %@, before the reset in %@.",
                countdownLabel(from: now, to: hitsLimitAt),
                countdownLabel(from: now, to: resetsAt)
            )
        } else if abs(result.deltaPercent) <= 2 {
            projectionSentence = L("Projected %lld%% used by the reset — on pace.", projected)
        } else if result.deltaPercent > 0 {
            projectionSentence = L(
                "Projected %d%% used by the reset, %.0f%% ahead of the pace the elapsed window implies.",
                projected, result.deltaPercent
            )
        } else {
            projectionSentence = L(
                "Projected %d%% used by the reset, %.0f%% of the window still in reserve.",
                projected, -result.deltaPercent
            )
        }
        var sentences = [basis, projectionSentence]
        // Same gate as the caption, so the tooltip never explains a share the
        // caption did not print, and never omits one it did.
        if let unused = unusedSharePercent(for: result, windowSeconds: windowSeconds) {
            sentences.append(L(
                "At this pace about %lld%% of the window goes unused by the reset.",
                unused
            ))
        }
        return sentences.joined(separator: " ")
    }

    /// Human label for a validated duration: the two lengths Claude and Codex
    /// actually report, else a plain hours/days rendering of the number.
    private static func windowLengthLabel(seconds: Int) -> String {
        switch seconds {
        case claudeFiveHourSeconds: return L("5-hour")
        case claudeSevenDaySeconds: return L("7-day")
        default:
            let hours = seconds / 3600
            if hours >= 24, seconds % 86400 == 0 { return L("%lld-day", hours / 24) }
            return L("%lld-hour", hours)
        }
    }

    /// "2d 3h" / "3h 20m" / "45m" / "<1m", mirroring the window column's own
    /// countdown shape. Computed against the passed dates, never a hidden
    /// wall clock, so fixtures stay deterministic.
    static func countdownLabel(from now: Date, to date: Date) -> String {
        countdownLabel(seconds: date.timeIntervalSince(now))
    }

    /// Countdown label for an already-computed interval (clamped at zero).
    static func countdownLabel(seconds: TimeInterval) -> String {
        let value = max(0, seconds)
        if value < 60 { return L("<1m") }
        let minutes = Int(value / 60)
        let hours = minutes / 60
        let days = hours / 24
        // Same three keys the popover's reset countdown uses.
        if days > 0 { return L("%lldd %lldh", days, hours % 24) }
        if hours > 0 { return L("%lldh %lldm", hours, minutes % 60) }
        return L("%lldm", minutes)
    }
}
