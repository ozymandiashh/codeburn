import Foundation

/// Scans `mac/Sources` for user-facing string literals that never reach the
/// `Localizable.strings` catalog (#1219).
///
/// # Why this exists
///
/// `LocalizationCatalogTests` diffs the `en` and `zh-Hans` tables against each
/// other. That catches a key translated in one locale and not the other, but it
/// is blind to the failure that actually happens: a new feature ships a bare
/// `Text("Second row")`, the literal never becomes a key, both tables stay in
/// perfect agreement, and a zh-Hans build renders English. That is exactly how
/// #1252 and #1243 landed — neither PR's diff contained a single `L(` call.
///
/// So this scanner reads the source instead of the catalog: it finds the call
/// sites whose argument AppKit or SwiftUI puts on screen and fails when one of
/// them is handed a literal rather than `L(...)`.
///
/// # Kept out of the app target on purpose
///
/// Nothing here runs in the shipped binary — it reads `.swift` files off disk,
/// which only makes sense from the test bundle. It lives in its own file rather
/// than inside the test so the standalone `swiftc` harness (this host cannot run
/// `swift test`) can exercise the same code the suite does, instead of a
/// reimplementation that could drift from it.
///
/// # Why it walks bytes, once
///
/// swift-testing runs suites concurrently in one process, so a slow test is not
/// merely slow: it steals CPU from every wall-clock assertion running beside it.
/// `ServeConnectionTests` asserts that cancelling a hung request returns inside
/// 500 ms (#1333), and this scan used to burn 16 s of CPU next to it.
///
/// The cost was all algorithmic, not essential — the tree is 88 files and 1.3 MB:
///
/// - the file was walked once per call-site pattern, 26 times over;
/// - every comparison built a fresh `Array` slice at each character position,
///   some 34 million allocations per run;
/// - `enclosingTypeName` rescanned the whole file from the top for every
///   display-label property it found, which is quadratic;
/// - and the four whole-tree scans the suite performs each re-read every file.
///
/// It now blanks comments in place, walks each file exactly once with a
/// first-byte dispatch table, tracks the enclosing type as it passes it, and
/// memoises the result so the suite's four scans cost one. Every pattern is
/// ASCII; literal text is decoded only for the literals actually found.
///
/// Detection is unchanged. This is a performance fix, and
/// `LocalizationCoverageTests` is its oracle.
enum LocalizationSourceScanner {

    // MARK: - What counts as user-facing

    /// A call site whose string argument is rendered to the user.
    ///
    /// Each entry is matched as a literal prefix immediately followed by the
    /// argument, so `Text(L("…"))` never matches and `Text("…")` always does.
    /// Adding a new SwiftUI or AppKit surface that displays a string means
    /// adding it here — the list is the definition of "user-facing", and a
    /// surface missing from it is a hole in the guard.
    static let userFacingCallSites: [String] = [
        // SwiftUI views whose first argument is the visible title.
        "Text(",
        "Button(",
        "Toggle(",
        "Picker(",
        "Menu(",
        "Section(",
        "Label(",
        "TextField(",
        "SecureField(",
        "Stepper(",
        "Link(",
        // SwiftUI accessibility, which VoiceOver reads aloud.
        ".accessibilityLabel(",
        ".accessibilityValue(",
        ".accessibilityHint(",
        ".accessibilityAction(named:",
        // Tooltips and window/navigation chrome.
        ".help(",
        ".navigationTitle(",
        // AppKit: the status-item menu, alerts, and window titles.
        "NSMenuItem(title:",
        ".messageText =",
        ".informativeText =",
        "addButton(withTitle:",
        ".title =",
        ".toolTip =",
        // Notification copy, which the notifier hands straight to
        // UNMutableNotificationContent.
        "post(title:",
        // This app's own section-header helper.
        "sectionCaption(",
    ]

    /// Words that are the same in every locale, so a literal made only of them
    /// is not a translation failure.
    ///
    /// Deliberately tiny, and deliberately a vocabulary rather than a list of
    /// exempt call sites: an exemption keyed to a file and line goes stale the
    /// moment the file is edited, and quietly stops guarding anything. These are
    /// the three that actually occur:
    ///
    /// - `CodeBurn` — the product name.
    /// - `tok` — the token unit, kept verbatim next to a formatted figure.
    /// - `USD` — a currency code.
    ///
    /// Provider, model and plan names never appear here because they are never
    /// literals in a view: they arrive as values and are substituted into a
    /// `%@`, which is the routed form this scanner is asking for.
    static let untranslatableWords: Set<String> = ["codeburn", "tok", "usd"]

    // MARK: - Display-label properties

    /// Computed `String` properties this codebase uses to give an enum its
    /// on-screen name — the Settings pickers render exactly these.
    ///
    /// They are not call sites, so the call-site scan above cannot see them:
    /// `case .quotaRemaining: "Quota remaining"` is just a string returned from
    /// a switch. Yet a new `MenubarSecondRowMetric` case is precisely how the
    /// next untranslated picker option would arrive, so the property bodies get
    /// their own pass.
    static let displayLabelProperties: [String] = [
        "displayName",
        "displayLabel",
        "settingsLabel",
    ]

    /// Properties that legitimately return untranslated text, with the reason.
    ///
    /// This is the documented denylist. It names the declaring type as well as
    /// the property so that adding a `displayName` elsewhere is still guarded.
    ///
    /// - `CapacityDockGlanceWindowKind.displayName` — a stand-in for a provider's
    ///   own window label ("Weekly", "5-hour"), used only when the provider
    ///   publishes none. Those labels are provider data and are never
    ///   translated, so translating the fallback alone would make the same
    ///   VoiceOver sentence half-Chinese depending on which provider is
    ///   selected.
    /// - `CapacityDockProvider.displayName` and `CodexUsage.*.displayName` —
    ///   provider, model and plan names, which the catalog header lists as
    ///   verbatim in every locale.
    /// - `LanguagePreference.displayLabel` — each language names itself
    ///   ("English", "简体中文"). Translating an endonym defeats the picker:
    ///   someone opens it because the UI is in a language they cannot read.
    ///   Its `.system` case is routed through `L(…)` even so.
    static let untranslatedLabelProperties: Set<String> = [
        "CapacityDockGlanceWindowKind.displayName",
        "CapacityDockProvider.displayName",
        "CapacityDockProviderCatalogEntry.displayName",
        "LanguagePreference.displayLabel",
        "PlanType.displayName",
        "Tier.displayName",
    ]

    // MARK: - Findings

    struct Finding: Equatable, CustomStringConvertible {
        let file: String
        let line: Int
        let callSite: String
        let literal: String

        var description: String {
            "\(file):\(line): \(callSite)\"\(literal)\" is shown to the user but never reaches the catalog — wrap it in L(\"…\")"
        }
    }

    /// Everything one walk of the tree produces, plus what it cost.
    struct Scan: Sendable {
        var unroutedLiterals: [Finding] = []
        var unroutedLabelProperties: [Finding] = []
        var requestedKeys: Set<String> = []
        var fileCount = 0
        var byteCount = 0
        /// Wall time and CPU time for this scan. `LocalizationCoverageTests`
        /// prints them once and fails if the CPU figure regresses past a
        /// ceiling, because the cost of this scan is a property of the whole
        /// suite, not just of this test.
        var wallSeconds: Double = 0
        /// CPU consumed by the scanning thread alone. Process CPU would bill
        /// this scan for every test swift-testing runs beside it; the walk is
        /// synchronous, so it never leaves the thread it is measured on.
        var cpuSeconds: Double = 0
    }

    // MARK: - Byte classification
    //
    // Every pattern this scanner matches is ASCII. A byte at or above 0x80 is a
    // UTF-8 lead or continuation byte, and counts as a letter so a match can
    // never start in the middle of non-ASCII text.

    @inline(__always)
    static func isLetter(_ b: UInt8) -> Bool {
        (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) || b >= 0x80
    }

    @inline(__always)
    static func isDigit(_ b: UInt8) -> Bool { b >= 0x30 && b <= 0x39 }

    @inline(__always)
    static func isIdentifier(_ b: UInt8) -> Bool {
        isLetter(b) || isDigit(b) || b == UInt8(ascii: "_")
    }

    @inline(__always)
    static func isSpace(_ b: UInt8) -> Bool {
        b == 0x20 || b == 0x09 || b == 0x0A || b == 0x0D
    }

    @inline(__always)
    static func isUppercase(_ b: UInt8) -> Bool { b >= 0x41 && b <= 0x5A }

    /// Non-allocating prefix comparison. The previous shape,
    /// `Array(code[i..<i+n]) == needle`, allocated an array at every character
    /// position of every file for every pattern, and was most of the old cost.
    @inline(__always)
    static func matches(_ needle: [UInt8], at index: Int, in code: [UInt8]) -> Bool {
        guard index + needle.count <= code.count else { return false }
        for k in 0..<needle.count where code[index + k] != needle[k] { return false }
        return true
    }

    // MARK: - One file, tokenized once

    /// A class, not a struct, so the line index can be built lazily and shared.
    final class ScannedFile {
        let name: String
        /// Source bytes with comment bodies blanked to spaces. Blanking rather
        /// than deleting keeps every offset equal to the original file's, so
        /// line numbers need no second mapping.
        let code: [UInt8]

        /// Built on the first finding, not up front: a passing run reports
        /// nothing, and indexing every newline in the tree cost more than the
        /// rest of the walk put together.
        private var lineStarts: [Int]?

        init(name: String, source: [UInt8]) {
            self.name = name
            self.code = LocalizationSourceScanner.strippingComments(source)
        }

        /// 1-based line for a byte offset, by binary search. The old linear
        /// count from the top of the file was fine for a handful of findings and
        /// quadratic the moment there were many.
        func line(at offset: Int) -> Int {
            let starts: [Int]
            if let cached = lineStarts {
                starts = cached
            } else {
                var built = [0]
                built.reserveCapacity(code.count / 30)
                for i in 0..<code.count where code[i] == 0x0A { built.append(i + 1) }
                lineStarts = built
                starts = built
            }
            var low = 0
            var high = starts.count - 1
            while low < high {
                let mid = (low + high + 1) / 2
                if starts[mid] <= offset { low = mid } else { high = mid - 1 }
            }
            return low + 1
        }
    }

    // MARK: - Entry points

    /// One walk of the tree, memoised.
    ///
    /// The suite asks for literals, label properties and keys in four separate
    /// tests; each used to re-read and re-tokenize all 88 files. They are all
    /// answers to the same walk, and the sources cannot change while the suite
    /// runs.
    static func scan(directory: URL) throws -> Scan {
        try cache.scan(directory)
    }

    /// Every user-facing literal in `directory` that is not routed through `L(…)`.
    static func unroutedLiterals(in directory: URL) throws -> [Finding] {
        try scan(directory: directory).unroutedLiterals
    }

    /// Bare literals returned from a display-label property.
    static func unroutedLabelProperties(in directory: URL) throws -> [Finding] {
        try scan(directory: directory).unroutedLabelProperties
    }

    /// Every key passed to `L(…)` anywhere under `directory`.
    ///
    /// The other direction of the same guard: `unroutedLiterals` catches copy
    /// that never became a key, this catches a key that never became an entry.
    /// Both ship English in a zh-Hans build, and neither is visible to the
    /// compiler or to a catalog-versus-catalog diff.
    static func requestedKeys(in directory: URL) throws -> Set<String> {
        try scan(directory: directory).requestedKeys
    }

    /// Swift sources under `directory`, skipping hidden trees such as `.build`
    /// and anything inside a nested package.
    static func swiftFiles(in directory: URL) throws -> [URL] {
        guard let walker = FileManager.default.enumerator(
            at: directory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return [] }
        return walker
            .compactMap { $0 as? URL }
            .filter { $0.pathExtension == "swift" }
            .sorted { $0.path < $1.path }
    }

    // The per-source entry points. The suite uses these to test the rules
    // against a snippet rather than the repository.

    /// The scan for one file's text. Split out so the rules are testable
    /// against a source snippet rather than the repository.
    static func unroutedLiterals(inSource source: String, fileName: String) -> [Finding] {
        analyze(ScannedFile(name: fileName, source: [UInt8](source.utf8))).unroutedLiterals
    }

    static func unroutedLabelProperties(inSource source: String, fileName: String) -> [Finding] {
        analyze(ScannedFile(name: fileName, source: [UInt8](source.utf8))).unroutedLabelProperties
    }

    static func requestedKeys(inSource source: String) -> Set<String> {
        analyze(ScannedFile(name: "", source: [UInt8](source.utf8))).requestedKeys
    }

    // MARK: - Dispatch tables

    /// Call-site patterns bucketed by first byte, so one walk tests only the two
    /// or three patterns that could start here instead of walking the file once
    /// per pattern.
    private static let callSiteTable: [[(needle: [UInt8], text: String)]] = {
        var table = [[(needle: [UInt8], text: String)]](repeating: [], count: 256)
        for site in userFacingCallSites {
            let bytes = [UInt8](site.utf8)
            guard let first = bytes.first else { continue }
            table[Int(first)].append((bytes, site))
        }
        // Longest first, so `.accessibilityLabel(` wins over any prefix of it.
        for i in table.indices { table[i].sort { $0.needle.count > $1.needle.count } }
        return table
    }()

    /// `var displayName: String` and friends, matched whole.
    private static let labelPropertyNeedles: [(needle: [UInt8], property: String)] =
        displayLabelProperties.map { ([UInt8]("var \($0): String".utf8), $0) }

    private static let typeKeywords: [[UInt8]] =
        ["enum ", "struct ", "final class ", "class ", "extension "].map { [UInt8]($0.utf8) }

    /// Which of the four jobs a byte could possibly begin. Consulted once per
    /// byte, so the overwhelming majority cost one array read and one test.
    private static let interesting: [UInt8] = {
        var flags = [UInt8](repeating: 0, count: 256)
        for site in userFacingCallSites {
            if let first = site.utf8.first { flags[Int(first)] |= 0b0001 }
        }
        flags[Int(UInt8(ascii: "v"))] |= 0b0010          // var <label>: String
        flags[Int(UInt8(ascii: "L"))] |= 0b0100          // L(
        for b in "esfc" { flags[Int(b.asciiValue!)] |= 0b1000 }  // type declarations
        return flags
    }()

    /// The same test on the first *two* bytes.
    ///
    /// `.` is roughly one byte in thirty of Swift source and carries ten
    /// candidate call sites; `f` carries `func`/`final class`. Confirming the
    /// second byte before touching the candidate list turns almost all of those
    /// into a single table read — which matters because CI runs `swift test`
    /// unoptimised, where every `matches` call is a real call with a retain on
    /// the pattern array.
    private static let interesting2: [UInt8] = {
        var flags = [UInt8](repeating: 0, count: 256 * 256)
        func mark(_ prefix: String, _ bit: UInt8) {
            let bytes = Array(prefix.utf8)
            guard bytes.count >= 2 else {
                // One-byte trigger: every second byte is a possible follow-on.
                for second in 0..<256 { flags[Int(bytes[0]) << 8 | second] |= bit }
                return
            }
            flags[Int(bytes[0]) << 8 | Int(bytes[1])] |= bit
        }
        for site in userFacingCallSites { mark(site, 0b0001) }
        mark("va", 0b0010)
        mark("L(", 0b0100)
        for keyword in ["en", "st", "fi", "cl", "ex"] { mark(keyword, 0b1000) }
        return flags
    }()

    // MARK: - The single pass

    /// Call sites, display-label properties, `L(…)` keys and the enclosing-type
    /// index, all from one left-to-right walk.
    ///
    /// Tracking the enclosing type as the walk passes it is what removes the
    /// quadratic lookup: "nearest preceding declaration" is just the last one
    /// seen, which is exactly what a forward walk already knows.
    static func analyze(_ file: ScannedFile) -> Scan {
        let code = file.code
        var scan = Scan()
        scan.fileCount = 1
        scan.byteCount = code.count
        var owner = "?"
        var i = 0

        while i < code.count {
            let b = code[i]
            var flags = interesting[Int(b)]
            if flags == 0 {
                i += 1
                continue
            }
            // Confirm against the two-byte table before doing any real work.
            flags &= i + 1 < code.count ? interesting2[Int(b) << 8 | Int(code[i + 1])] : 0
            if flags == 0 {
                i += 1
                continue
            }

            if flags & 0b1000 != 0, let type = typeDeclaration(in: code, at: i) {
                owner = type
                i += 1
                continue
            }

            if flags & 0b0001 != 0, let site = callSite(in: code, at: i) {
                var cursor = i + site.needle.count
                // The argument may be on the next line; whitespace is not a
                // reason to stop looking for it.
                while cursor < code.count, isSpace(code[cursor]) { cursor += 1 }
                if cursor < code.count, code[cursor] == UInt8(ascii: "\""),
                   let literal = stringLiteral(in: code, startingAt: cursor),
                   needsTranslation(literal.value) {
                    scan.unroutedLiterals.append(
                        Finding(
                            file: file.name,
                            line: file.line(at: i),
                            callSite: site.text,
                            literal: literal.value
                        )
                    )
                }
                i += site.needle.count
                continue
            }

            if flags & 0b0010 != 0 {
                var matched = false
                for entry in labelPropertyNeedles where matches(entry.needle, at: i, in: code) {
                    scan.unroutedLabelProperties += labelFindings(
                        in: file, after: i + entry.needle.count, property: entry.property, owner: owner
                    )
                    i += entry.needle.count
                    matched = true
                    break
                }
                if matched { continue }
            }

            if flags & 0b0100 != 0, let key = requestedKey(in: code, at: i) {
                scan.requestedKeys.insert(key)
            }
            i += 1
        }

        scan.unroutedLiterals.sort { ($0.line, $0.literal) < ($1.line, $1.literal) }
        scan.unroutedLabelProperties.sort { ($0.line, $0.literal) < ($1.line, $1.literal) }
        return scan
    }

    /// The type name declared at `index`, if one is.
    private static func typeDeclaration(in code: [UInt8], at index: Int) -> String? {
        for needle in typeKeywords
        where matches(needle, at: index, in: code) && startsAWord(needle, at: index, in: code) {
            var j = index + needle.count
            let nameStart = j
            while j < code.count, isIdentifier(code[j]) { j += 1 }
            return j > nameStart ? String(decoding: code[nameStart..<j], as: UTF8.self) : nil
        }
        return nil
    }

    /// The user-facing call site starting at `index`, if one is.
    private static func callSite(in code: [UInt8], at index: Int) -> (needle: [UInt8], text: String)? {
        for candidate in callSiteTable[Int(code[index])]
        where matches(candidate.needle, at: index, in: code)
            && startsAWord(candidate.needle, at: index, in: code) {
            return candidate
        }
        return nil
    }

    /// Bare literals in the body of one display-label property.
    private static func labelFindings(
        in file: ScannedFile,
        after index: Int,
        property: String,
        owner: String
    ) -> [Finding] {
        let qualified = "\(owner).\(property)"
        guard !untranslatedLabelProperties.contains(qualified) else { return [] }
        guard let body = propertyBody(in: file.code, after: index) else { return [] }
        return valuePositionLiterals(in: file.code, range: body)
            .filter { needsTranslation($0.value) }
            .map {
                Finding(
                    file: file.name,
                    line: file.line(at: $0.offset),
                    callSite: "\(qualified): ",
                    literal: $0.value
                )
            }
    }

    /// The key of an `L("…")` call starting at `index`, if that is what this is.
    private static func requestedKey(in code: [UInt8], at index: Int) -> String? {
        // `L` has to be the whole identifier: `URL(`, `someL(` and `a.L(` are
        // not the localization function.
        if index > 0 {
            let previous = code[index - 1]
            if isIdentifier(previous) || previous == UInt8(ascii: ".") { return nil }
        }
        var cursor = index + 1
        guard cursor < code.count, code[cursor] == UInt8(ascii: "(") else { return nil }
        cursor += 1
        while cursor < code.count, isSpace(code[cursor]) { cursor += 1 }
        guard cursor < code.count, code[cursor] == UInt8(ascii: "\""),
              let literal = stringLiteral(in: code, startingAt: cursor) else { return nil }
        // The catalog stores the unescaped text, which is what NSBundle matches
        // against, so undo the escapes the source carries.
        return unescaped(literal.value)
    }

    /// Whether a match is the start of the call it names rather than the tail of
    /// a longer identifier.
    ///
    /// Without this `Label(` matches inside `.accessibilityLabel(`, and
    /// `Button(` inside `addButton(withTitle:`, reporting one string twice. A
    /// type name (`Text`, `Label`, `NSMenuItem`) is also rejected after a dot,
    /// since that is a member access; a method (`addButton`, `sectionCaption`)
    /// is not, because a dot is exactly how it is normally called.
    static func startsAWord(_ needle: [UInt8], at index: Int, in code: [UInt8]) -> Bool {
        guard index > 0, let first = needle.first else { return true }
        // A needle written as a member (`.accessibilityLabel(`) carries its own
        // boundary: the dot can only follow the receiver.
        guard isLetter(first) else { return true }
        let previous = code[index - 1]
        if isIdentifier(previous) { return false }
        if previous == UInt8(ascii: "."), isUppercase(first) { return false }
        return true
    }

    /// The brace-balanced body that follows a property declaration.
    static func propertyBody(in code: [UInt8], after index: Int) -> Range<Int>? {
        var i = index
        while i < code.count, code[i] != UInt8(ascii: "{") {
            // A declaration and its body are separated by whitespace only; a
            // computed property written with `=` is a stored one, not ours.
            if !isSpace(code[i]) { return nil }
            i += 1
        }
        guard i < code.count else { return nil }
        let start = i + 1
        var depth = 0
        while i < code.count {
            if code[i] == UInt8(ascii: "{") { depth += 1 }
            if code[i] == UInt8(ascii: "}") {
                depth -= 1
                if depth == 0 { return start..<i }
            }
            i += 1
        }
        return nil
    }

    /// String literals in *value* position within a property body — what the
    /// property evaluates to, rather than what it passes to something else.
    ///
    /// Value position is simply bracket depth zero. That is what separates
    /// `case .pro: "Pro"` (the property's result, which a picker renders) from
    /// `Locale(identifier: "en_US")` and `replacingOccurrences(of: "_", …)`
    /// (arguments to machinery, which are not copy). It also means a literal
    /// already wrapped in `L(…)` sits at depth one and is skipped, which is
    /// exactly the routed form this scan is asking for.
    static func valuePositionLiterals(
        in code: [UInt8],
        range: Range<Int>
    ) -> [(value: String, offset: Int)] {
        var found: [(value: String, offset: Int)] = []
        var depth = 0
        var i = range.lowerBound
        while i < range.upperBound {
            switch code[i] {
            case UInt8(ascii: "("), UInt8(ascii: "["):
                depth += 1
            case UInt8(ascii: ")"), UInt8(ascii: "]"):
                depth -= 1
            case UInt8(ascii: "\""):
                guard let literal = stringLiteral(in: code, startingAt: i) else { break }
                if depth == 0 { found.append((value: literal.value, offset: i)) }
                i = literal.end
                continue
            default:
                break
            }
            i += 1
        }
        return found
    }

    // MARK: - Lexing

    /// Replaces comment bodies with spaces, keeping newlines so byte offsets and
    /// line numbers still match the original file. Without this a doc comment
    /// that *mentions* `Text("literal")` — Localization.swift has one — reads as
    /// a violation.
    ///
    /// Blanks in place rather than building a second buffer: the old version
    /// appended to a `String` one `Character` at a time, which was a quarter of
    /// a second per run on its own.
    static func strippingComments(_ source: [UInt8]) -> [UInt8] {
        var out = source
        let slash = UInt8(ascii: "/")
        let star = UInt8(ascii: "*")
        let quote = UInt8(ascii: "\"")
        let space = UInt8(ascii: " ")
        var i = 0
        while i < out.count {
            // A string literal can contain "//" (a URL), so strings win.
            if out[i] == quote, let literal = stringLiteral(in: source, startingAt: i) {
                i = literal.end
                continue
            }
            if out[i] == slash, i + 1 < out.count, out[i + 1] == slash {
                while i < out.count, out[i] != 0x0A {
                    out[i] = space
                    i += 1
                }
                continue
            }
            if out[i] == slash, i + 1 < out.count, out[i + 1] == star {
                // Block comments nest in Swift.
                var depth = 0
                while i < out.count {
                    if out[i] == slash, i + 1 < out.count, out[i + 1] == star {
                        depth += 1
                        out[i] = space
                        out[i + 1] = space
                        i += 2
                        continue
                    }
                    if out[i] == star, i + 1 < out.count, out[i + 1] == slash {
                        depth -= 1
                        out[i] = space
                        out[i + 1] = space
                        i += 2
                        if depth == 0 { break }
                        continue
                    }
                    if out[i] != 0x0A { out[i] = space }
                    i += 1
                }
                continue
            }
            i += 1
        }
        return out
    }

    /// Reads the Swift string literal beginning at `start`, returning its
    /// contents and the index just past the closing quote. Handles `"""` blocks
    /// and backslash escapes; returns nil for an unterminated literal.
    ///
    /// The value is the raw source between the delimiters — escapes included, so
    /// `\(` survives for the interpolation stripper to recognise — decoded once
    /// the extent is known rather than accumulated byte by byte.
    static func stringLiteral(
        in code: [UInt8],
        startingAt start: Int
    ) -> (value: String, end: Int)? {
        let quote = UInt8(ascii: "\"")
        let backslash = UInt8(ascii: "\\")
        guard start < code.count, code[start] == quote else { return nil }

        let isMultiline = start + 2 < code.count
            && code[start + 1] == quote
            && code[start + 2] == quote
        let valueStart = start + (isMultiline ? 3 : 1)

        var i = valueStart
        while i < code.count {
            if code[i] == backslash {
                // Keep the backslash: `\(` has to survive for the interpolation
                // stripper to recognise it.
                i += 2
                continue
            }
            if code[i] == quote {
                if isMultiline {
                    if i + 2 < code.count, code[i + 1] == quote, code[i + 2] == quote {
                        return (String(decoding: code[valueStart..<i], as: UTF8.self), i + 3)
                    }
                } else {
                    return (String(decoding: code[valueStart..<i], as: UTF8.self), i + 1)
                }
            }
            if !isMultiline, code[i] == 0x0A { return nil }
            i += 1
        }
        return nil
    }

    // MARK: - Rules

    /// Whether a literal carries words a translator would have to translate.
    ///
    /// Interpolated segments are dropped first: `"\(count) calls"` is asking
    /// about the word `calls`, not about `count`. What is left is then reduced
    /// to runs of two or more letters, so a figure, a currency symbol, a unit
    /// suffix like `1M`, an em dash or an empty placeholder is never reported.
    static func needsTranslation(_ literal: String) -> Bool {
        !translatableWords(in: literal).isEmpty
    }

    static func translatableWords(in literal: String) -> [String] {
        withoutInterpolations(literal)
            .split(whereSeparator: { !$0.isLetter })
            .map { $0.lowercased() }
            .filter { $0.count >= 2 && !untranslatableWords.contains($0) }
    }

    /// Removes `\(…)` segments, brace-counting so a nested call such as
    /// `\(f(x))` is dropped whole rather than leaving a stray `)`.
    static func withoutInterpolations(_ literal: String) -> String {
        var out = ""
        let chars = Array(literal)
        var i = 0
        while i < chars.count {
            if chars[i] == "\\", i + 1 < chars.count, chars[i + 1] == "(" {
                var depth = 0
                var j = i + 1
                while j < chars.count {
                    if chars[j] == "(" { depth += 1 }
                    if chars[j] == ")" {
                        depth -= 1
                        if depth == 0 { j += 1; break }
                    }
                    j += 1
                }
                i = j
                continue
            }
            out.append(chars[i])
            i += 1
        }
        return out
    }

    /// Turns a source-level literal body into the string it denotes. Only the
    /// escapes the catalog actually uses are handled; an interpolated key would
    /// not be a constant key at all, so it is left alone and will simply fail to
    /// match an entry.
    static func unescaped(_ literal: String) -> String {
        var out = ""
        let chars = Array(literal)
        var i = 0
        while i < chars.count {
            guard chars[i] == "\\", i + 1 < chars.count else {
                out.append(chars[i])
                i += 1
                continue
            }
            switch chars[i + 1] {
            case "n": out.append("\n")
            case "t": out.append("\t")
            case "r": out.append("\r")
            case "\"": out.append("\"")
            case "'": out.append("'")
            case "\\": out.append("\\")
            default:
                out.append(chars[i])
                out.append(chars[i + 1])
            }
            i += 2
        }
        return out
    }

    // MARK: - Memoisation

    /// Caches one `Scan` per directory. swift-testing runs the suite's tests
    /// concurrently, so this is lock-guarded and the first caller does the work.
    private final class ScanCache: @unchecked Sendable {
        private let lock = NSLock()
        private var scans: [String: Scan] = [:]

        func scan(_ directory: URL) throws -> Scan {
            let key = directory.standardizedFileURL.path
            lock.lock()
            if let cached = scans[key] {
                lock.unlock()
                return cached
            }
            lock.unlock()

            let fresh = try LocalizationSourceScanner.walk(directory)

            lock.lock()
            // A concurrent caller may have finished first; either result is the
            // same scan of the same unchanging sources, so keep whichever landed.
            let stored = scans[key] ?? fresh
            scans[key] = stored
            lock.unlock()
            return stored
        }
    }

    private static let cache = ScanCache()

    /// The uncached walk. Reads each file once and runs the single pass over it.
    private static func walk(_ directory: URL) throws -> Scan {
        let wallStart = ContinuousClock.now
        let cpuStart = cpuSeconds()

        var total = Scan()
        for url in try swiftFiles(in: directory) {
            let bytes = [UInt8](try Data(contentsOf: url))
            let one = analyze(ScannedFile(name: url.lastPathComponent, source: bytes))
            total.unroutedLiterals += one.unroutedLiterals
            total.unroutedLabelProperties += one.unroutedLabelProperties
            total.requestedKeys.formUnion(one.requestedKeys)
            total.fileCount += 1
            total.byteCount += one.byteCount
        }
        total.unroutedLiterals.sort { ($0.file, $0.line, $0.literal) < ($1.file, $1.line, $1.literal) }
        total.unroutedLabelProperties.sort { ($0.file, $0.line, $0.literal) < ($1.file, $1.line, $1.literal) }

        let elapsed = ContinuousClock.now - wallStart
        total.wallSeconds = Double(elapsed.components.seconds)
            + Double(elapsed.components.attoseconds) / 1e18
        total.cpuSeconds = cpuSeconds() - cpuStart
        return total
    }

    /// CPU time consumed by the calling thread, in seconds.
    private static func cpuSeconds() -> Double {
        Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)) / 1_000_000_000
    }
}
