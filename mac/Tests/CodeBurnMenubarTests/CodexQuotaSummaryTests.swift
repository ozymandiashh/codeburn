import Foundation
import Testing
@testable import CodeBurnMenubar

private func usage(
    balance: Double? = nil,
    hasCredits: Bool = false,
    unlimited: Bool = false,
    creditLimit: CodexUsage.CreditLimit? = nil
) -> CodexUsage {
    CodexUsage(
        plan: .business,
        primary: nil,
        secondary: nil,
        additionalLimits: [],
        creditsBalance: balance,
        hasCredits: hasCredits,
        creditsUnlimited: unlimited,
        creditLimit: creditLimit,
        resetCredits: nil,
        fetchedAt: Date()
    )
}

private func limit(used: Double, of total: Double, reached: Bool = false) -> CodexUsage.CreditLimit {
    CodexUsage.CreditLimit(
        used: used,
        limit: total,
        usedPercent: used / total * 100,
        resetsAt: Date(timeIntervalSince1970: 1_785_542_400),
        windowSeconds: 31 * 86_400,
        reached: reached
    )
}

@MainActor
private func store(_ usage: CodexUsage) -> AppStore {
    let store = AppStore()
    store.codexUsage = usage
    // Pinned: the default depends on whether this machine has Codex connected.
    store.codexLoadState = .loaded
    return store
}

@MainActor
struct CodexQuotaSummaryTests {
    @Test("credit-settled balances group without a currency symbol")
    func creditSettledBalanceIsGroupedAndUnprefixed() {
        let store = store(usage(balance: 3410.4, hasCredits: true))
        #expect(store.quotaSummary(for: .codex)?.footerLines == ["Credits remaining · 3,410"])
    }

    @Test("dollar balances keep the currency formatting")
    func dollarBalanceKeepsCurrencyFormatting() {
        let store = store(usage(balance: 3410.4, hasCredits: false))
        #expect(store.quotaSummary(for: .codex)?.footerLines == ["Credits remaining · $3,410.40"])
    }

    @Test("an exact-half credit balance rounds up, matching the desktop decoder")
    func creditBalanceRoundsHalfUp() {
        let store = store(usage(balance: 3410.5, hasCredits: true))
        #expect(store.quotaSummary(for: .codex)?.footerLines == ["Credits remaining · 3,411"])
    }

    @Test("an uncapped credit account says so instead of showing nothing")
    func uncappedAccountSaysUnlimited() {
        let store = store(usage(hasCredits: true, unlimited: true))
        #expect(store.quotaSummary(for: .codex)?.footerLines == ["Credits · Unlimited"])
    }

    @Test("the allowance row drives the chip with the short label")
    func allowanceRowUsesTheShortLabel() {
        let store = store(usage(creditLimit: limit(used: 3033, of: 10_000)))
        let summary = store.quotaSummary(for: .codex)
        #expect(summary?.primary?.label == "Monthly usage limit")
        #expect(summary?.primary?.percent == 0.3033)
        #expect(summary?.footerLines.isEmpty == true)
    }

    @Test("a spent-out allowance is called out on the chip")
    func reachedAllowanceIsCalledOut() {
        let store = store(usage(creditLimit: limit(used: 10_000, of: 10_000, reached: true)))
        #expect(store.quotaSummary(for: .codex)?.primary?.label == "Monthly usage limit · limit reached")
    }

    // The reset forecast is an estimate over a public record, not something the
    // account reported, so it must never reach `footerLines` — which is the
    // adapter's normalized output and is consumed verbatim by the Capacity Dock,
    // the hover card and every test above. It rides its own field instead.

    @Test("the reset forecast never lands in the adapter's footer lines")
    func forecastStaysOutOfFooterLines() {
        let store = store(usage(hasCredits: true, unlimited: true))
        let summary = store.quotaSummary(for: .codex)
        #expect(summary?.footerLines == ["Credits · Unlimited"])
        #expect(summary?.footerLines.contains { $0.hasPrefix("Reset forecast") } == false)
    }

    @Test("the reset forecast rides its own field on a connected account")
    func forecastRidesItsOwnField() {
        let store = store(usage(hasCredits: true, unlimited: true))
        let summary = store.quotaSummary(for: .codex)
        #expect(summary?.forecastLines.isEmpty == false)
        #expect(summary?.forecastLines.first?.hasPrefix("Reset forecast: ") == true)
    }

    @Test("a provider that reports no forecast carries an empty field, not a placeholder")
    func otherProvidersCarryNoForecast() {
        // Every other adapter uses the defaulted initializer, so nothing about
        // their summaries changed.
        let summary = QuotaSummary(
            providerFilter: .claude, connection: .connected, primary: nil,
            details: [], planLabel: nil, footerLines: []
        )
        #expect(summary.forecastLines.isEmpty)
    }
}
