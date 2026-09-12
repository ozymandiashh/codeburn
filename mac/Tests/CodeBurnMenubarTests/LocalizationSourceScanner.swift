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

    // MARK: - Scanning

    /// Every user-facing literal in `directory` that is not routed through `L(…)`.
    static func unroutedLiterals(in directory: URL) throws -> [Finding] {
        var findings: [Finding] = []
        for file in try swiftFiles(in: directory) {
            let source = try String(contentsOf: file, encoding: .utf8)
            findings += unroutedLiterals(
                inSource: source,
                fileName: file.lastPathComponent
            )
        }
        return findings.sorted {
            ($0.file, $0.line, $0.literal) < ($1.file, $1.line, $1.literal)
        }
    }

    static func swiftFiles(in directory: URL) throws -> [URL] {
        guard let walker = FileManager.default.enumerator(
            at: directory,
            includingPropertiesForKeys: nil
        ) else { return [] }
        return walker
            .compactMap { $0 as? URL }
            .filter { $0.pathExtension == "swift" }
            .sorted { $0.path < $1.path }
    }

    /// The scan for one file's text. Split out so the rules are testable
    /// against a source snippet rather than the repository.
    static func unroutedLiterals(inSource source: String, fileName: String) -> [Finding] {
        let code = Array(strippingComments(source))
        var findings: [Finding] = []

        for callSite in userFacingCallSites {
            let needle = Array(callSite)
            var index = 0
            while index + needle.count <= code.count {
                guard Array(code[index..<(index + needle.count)]) == needle,
                      startsAWord(needle, at: index, in: code) else {
                    index += 1
                    continue
                }
                var cursor = index + needle.count
                // The argument may be on the next line; whitespace is not a
                // reason to stop looking for it.
                while cursor < code.count, code[cursor].isWhitespace { cursor += 1 }
                if cursor < code.count, code[cursor] == "\"",
                   let literal = stringLiteral(in: code, startingAt: cursor),
                   needsTranslation(literal.value) {
                    findings.append(
                        Finding(
                            file: fileName,
                            line: lineNumber(of: index, in: code),
                            callSite: callSite,
                            literal: literal.value
                        )
                    )
                }
                index += needle.count
            }
        }
        // Call sites are scanned one kind at a time, so sort back into reading
        // order — a failure message that jumps around the file is hard to act on.
        return findings.sorted { ($0.line, $0.literal) < ($1.line, $1.literal) }
    }

    // MARK: - Copy-bearing declarations

    /// Types whose whole job is producing sentences for the user.
    ///
    /// This codebase puts the wording for a feature in a `…Presentation` (or
    /// `…Format`) type so the views stay thin and the copy stays testable —
    /// `CopilotQuotaPresentation`, `ProviderReconnectPresentation`,
    /// `CodexBankedResetPresentation`, `QuotaPacePresentation`,
    /// `EarlyQuotaResetFormat`. Every `String` a type like that returns is copy
    /// by construction.
    ///
    /// This is the pass that the second merge from main proved was missing:
    /// #1328 and #1329 each arrived as a new presentation type holding dozens of
    /// English sentences, and neither the call-site pass nor the display-label
    /// pass could see a single one of them — the views only ever render
    /// `Text(presentation.caption)`.
    static let copyBearingTypeSuffixes: [String] = ["Presentation", "Format"]

    /// Members that carry copy wherever they are declared, whatever the type is
    /// called. `displayName`/`displayLabel`/`settingsLabel` name an enum for a
    /// picker; the rest are the notification, dock-band and hover-caption
    /// accessors the quota features hang their wording off.
    static let copyBearingMembers: Set<String> = [
        "displayName",
        "displayLabel",
        "settingsLabel",
        "notificationTitle",
        "notificationBody",
        "noticeText",
        "noticeHelpText",
        "caption",
        "helpText",
        "rowLabel",
    ]

    /// Declarations that legitimately return untranslated text, with the reason.
    ///
    /// This is the documented denylist. Each entry names the declaring type as
    /// well as the member, so exempting one `displayName` does not exempt every
    /// `displayName` in the app.
    ///
    /// - `CapacityDockGlanceWindowKind.displayName` — a stand-in for a provider's
    ///   own window label ("weekly", "5-hour"), used only when the provider
    ///   publishes none. Those labels are provider data and are never
    ///   translated, so translating the fallback alone would make the same
    ///   VoiceOver sentence half-Chinese depending on which provider is
    ///   selected.
    /// - `CapacityDockProvider.displayName`,
    ///   `CapacityDockProviderCatalogEntry.displayName`, `PlanType.displayName`,
    ///   `Tier.displayName` — provider, model and plan names, which the catalog
    ///   header lists as verbatim in every locale.
    /// - `ExportFormat.cliName`, `ExportFormat.suffix` — caught only because the
    ///   type's name ends in "Format"; it is an export-format enum, not a
    ///   formatter of copy. These return a `codeburn` CLI argument value and a
    ///   file extension, neither of which is ever shown as prose.
    static let untranslatedCopyDeclarations: Set<String> = [
        "CapacityDockGlanceWindowKind.displayName",
        "CapacityDockProvider.displayName",
        "CapacityDockProviderCatalogEntry.displayName",
        "PlanType.displayName",
        "Tier.displayName",
        "ExportFormat.cliName",
        "ExportFormat.suffix",
    ]

    /// Bare literals returned from a copy-bearing declaration.
    static func unroutedCopyDeclarations(in directory: URL) throws -> [Finding] {
        var findings: [Finding] = []
        for file in try swiftFiles(in: directory) {
            let source = try String(contentsOf: file, encoding: .utf8)
            findings += unroutedCopyDeclarations(
                inSource: source,
                fileName: file.lastPathComponent
            )
        }
        return findings.sorted {
            ($0.file, $0.line, $0.literal) < ($1.file, $1.line, $1.literal)
        }
    }

    static func unroutedCopyDeclarations(inSource source: String, fileName: String) -> [Finding] {
        let code = Array(strippingComments(source))
        let types = typeDeclarations(in: code)
        var findings: [Finding] = []

        for keyword in ["var ", "func "] {
            let needle = Array(keyword)
            var index = 0
            while index + needle.count <= code.count {
                guard Array(code[index..<(index + needle.count)]) == needle,
                      startsAWord(needle, at: index, in: code) else {
                    index += 1
                    continue
                }
                let declaration = index
                index += needle.count
                guard let header = declarationHeader(in: code, from: declaration),
                      returnsString(header.text) else { continue }
                let owner = types.last { $0.offset < declaration }?.name ?? "?"
                let name = memberName(header.text, keyword: keyword)
                let qualified = "\(owner).\(name)"
                guard !untranslatedCopyDeclarations.contains(qualified) else { continue }
                let isCopyType = copyBearingTypeSuffixes.contains { owner.hasSuffix($0) }
                guard isCopyType || copyBearingMembers.contains(name) else { continue }
                guard let body = propertyBody(in: code, after: header.braceOffset) else { continue }
                for literal in valuePositionLiterals(in: Array(code[body])) where needsTranslation(literal.value) {
                    findings.append(
                        Finding(
                            file: fileName,
                            line: lineNumber(of: body.lowerBound + literal.offset, in: code),
                            callSite: "\(qualified): ",
                            literal: literal.value
                        )
                    )
                }
            }
        }
        return findings.sorted { ($0.line, $0.literal) < ($1.line, $1.literal) }
    }

    /// The text of a declaration up to its opening brace, or nil when it has no
    /// body (a stored property, a protocol requirement).
    static func declarationHeader(
        in code: [Character],
        from start: Int
    ) -> (text: String, braceOffset: Int)? {
        var text = ""
        var depth = 0
        var i = start
        while i < code.count {
            let c = code[i]
            // Only parentheses and brackets nest here. Angle brackets must NOT
            // count: the `>` in `-> String` would close a bracket that never
            // opened, leave the depth negative, and make every function
            // invisible to this pass — which is exactly the bug that let
            // `QuotaPacePresentation.caption` through.
            if c == "(" || c == "[" { depth += 1 }
            if c == ")" || c == "]" { depth -= 1 }
            if depth == 0, c == "{" { return (text, i) }
            // `=` starts a stored value and `;`/`}` end the declaration: either
            // way there is no computed body to look inside.
            if depth == 0, c == "=" || c == ";" || c == "}" { return nil }
            text.append(c)
            i += 1
        }
        return nil
    }

    /// Whether a declaration header declares a `String` result. The tuple form
    /// is the shape the banked-reset notification uses.
    static func returnsString(_ header: String) -> Bool {
        let squeezed = header.filter { !$0.isWhitespace }
        return squeezed.hasSuffix(":String")
            || squeezed.hasSuffix(":String?")
            || squeezed.hasSuffix("->String")
            || squeezed.hasSuffix("->String?")
            || squeezed.contains("->(title:String,body:String)")
    }

    static func memberName(_ header: String, keyword: String) -> String {
        String(header.dropFirst(keyword.count).prefix { $0.isLetter || $0.isNumber || $0 == "_" })
    }

    /// The brace-balanced body that follows a property declaration.
    static func propertyBody(in code: [Character], after index: Int) -> Range<Int>? {
        var i = index
        while i < code.count, code[i] != "{" {
            // A declaration and its body are separated by whitespace only; a
            // computed property written with `=` is a stored one, not ours.
            if !code[i].isWhitespace { return nil }
            i += 1
        }
        guard i < code.count else { return nil }
        let start = i + 1
        var depth = 0
        while i < code.count {
            if code[i] == "{" { depth += 1 }
            if code[i] == "}" {
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
    static func valuePositionLiterals(in code: [Character]) -> [(value: String, offset: Int)] {
        var found: [(value: String, offset: Int)] = []
        var depth = 0
        // A `case "five_hour":` literal is a pattern being matched, not copy
        // being produced. Without this, every string-keyed switch in a
        // copy-bearing type reports its own match keys.
        var inCasePattern = false
        var i = 0
        while i < code.count {
            if !inCasePattern, depth == 0, matchesKeyword("case", at: i, in: code) {
                inCasePattern = true
                i += 4
                continue
            }
            switch code[i] {
            case "(", "[":
                depth += 1
            case ")", "]":
                depth -= 1
            case ":" where depth == 0, "\n":
                // A pattern list ends at its colon; the newline is the backstop
                // for `if case`/`guard case`, which have no colon at all and
                // would otherwise swallow the rest of the body.
                inCasePattern = false
            case "\"":
                guard let literal = stringLiteral(in: code, startingAt: i) else { break }
                if depth == 0, !inCasePattern {
                    found.append((value: literal.value, offset: i))
                }
                i = literal.end
                continue
            default:
                break
            }
            i += 1
        }
        return found
    }

    /// Whether `word` appears at `index` as a whole identifier.
    static func matchesKeyword(_ word: String, at index: Int, in code: [Character]) -> Bool {
        let needle = Array(word)
        guard index + needle.count <= code.count,
              Array(code[index..<(index + needle.count)]) == needle,
              startsAWord(needle, at: index, in: code) else { return false }
        let after = index + needle.count
        guard after < code.count else { return true }
        return !(code[after].isLetter || code[after].isNumber || code[after] == "_")
    }

    /// The nearest `enum`/`struct`/`class`/`extension` name declared above
    /// `index`, so a denylist entry can name the type it exempts.
    ///
    /// Nearest-preceding, not brace-scoped: a member declared after a nested
    /// type's closing brace is attributed to that nested type rather than the
    /// outer one. That is imprecise but self-consistent — a finding prints the
    /// qualified name verbatim, and that is the string to paste into
    /// `untranslatedCopyDeclarations` — and it fails toward guarding more, never
    /// less.
    static func enclosingTypeName(before index: Int, in code: [Character]) -> String {
        typeDeclarations(in: code).last { $0.offset < index }?.name ?? "?"
    }

    /// Every type declaration in source order, as (offset, name).
    ///
    /// Built once per file and searched, rather than rescanning the file for
    /// each member: the previous shape was quadratic and took minutes on
    /// AppStore.swift alone.
    static func typeDeclarations(in code: [Character]) -> [(offset: Int, name: String)] {
        let keywords = ["enum ", "struct ", "final class ", "class ", "extension "].map(Array.init)
        var found: [(offset: Int, name: String)] = []
        var i = 0
        while i < code.count {
            for needle in keywords where i + needle.count <= code.count {
                guard Array(code[i..<(i + needle.count)]) == needle,
                      startsAWord(needle, at: i, in: code) else { continue }
                var j = i + needle.count
                var name = ""
                while j < code.count, code[j].isLetter || code[j].isNumber || code[j] == "_" {
                    name.append(code[j])
                    j += 1
                }
                if !name.isEmpty { found.append((offset: i, name: name)) }
            }
            i += 1
        }
        return found
    }

    // MARK: - Keys the code asks for

    /// Every key passed to `L(…)` anywhere under `directory`.
    ///
    /// The other direction of the same guard: `unroutedLiterals` catches copy
    /// that never became a key, this catches a key that never became an entry.
    /// Both ship English in a zh-Hans build, and neither is visible to the
    /// compiler or to a catalog-versus-catalog diff.
    static func requestedKeys(in directory: URL) throws -> Set<String> {
        var keys: Set<String> = []
        for file in try swiftFiles(in: directory) {
            let source = try String(contentsOf: file, encoding: .utf8)
            keys.formUnion(requestedKeys(inSource: source))
        }
        return keys
    }

    static func requestedKeys(inSource source: String) -> Set<String> {
        let chars = Array(strippingComments(source))
        var keys: Set<String> = []
        var i = 0
        while i < chars.count {
            defer { i += 1 }
            guard chars[i] == "L" else { continue }
            // `L` has to be the whole identifier: `URL(`, `someL(` and `a.L(`
            // are not the localization function.
            if i > 0 {
                let previous = chars[i - 1]
                if previous.isLetter || previous.isNumber || previous == "_" || previous == "." {
                    continue
                }
            }
            var cursor = i + 1
            guard cursor < chars.count, chars[cursor] == "(" else { continue }
            cursor += 1
            while cursor < chars.count, chars[cursor].isWhitespace { cursor += 1 }
            guard cursor < chars.count, chars[cursor] == "\"",
                  let literal = stringLiteral(in: chars, startingAt: cursor) else { continue }
            // The catalog stores the unescaped text, which is what NSBundle
            // matches against, so undo the escapes the source carries.
            keys.insert(unescaped(literal.value))
        }
        return keys
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

    /// Whether a match is the start of the call it names rather than the tail of
    /// a longer identifier.
    ///
    /// Without this `Label(` matches inside `.accessibilityLabel(`, and
    /// `Button(` inside `addButton(withTitle:`, reporting one string twice. A
    /// type name (`Text`, `Label`, `NSMenuItem`) is also rejected after a dot,
    /// since that is a member access; a method (`addButton`, `sectionCaption`)
    /// is not, because a dot is exactly how it is normally called.
    static func startsAWord(_ needle: [Character], at index: Int, in code: [Character]) -> Bool {
        guard index > 0, let first = needle.first else { return true }
        // A needle written as a member (`.accessibilityLabel(`) carries its own
        // boundary: the dot can only follow the receiver.
        guard first.isLetter else { return true }
        let previous = code[index - 1]
        if previous.isLetter || previous.isNumber || previous == "_" { return false }
        if previous == ".", first.isUppercase { return false }
        return true
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

    // MARK: - Lexing

    /// Replaces comment bodies with spaces, keeping newlines so reported line
    /// numbers still match the file. Without this a doc comment that *mentions*
    /// `Text("literal")` — Localization.swift has one — reads as a violation.
    static func strippingComments(_ source: String) -> String {
        var out = ""
        let chars = Array(source)
        var i = 0
        while i < chars.count {
            // A string literal can contain "//" (a URL), so strings win.
            if chars[i] == "\"" {
                if let literal = stringLiteral(in: chars, startingAt: i) {
                    out += String(chars[i..<literal.end])
                    i = literal.end
                    continue
                }
            }
            if chars[i] == "/", i + 1 < chars.count, chars[i + 1] == "/" {
                while i < chars.count, chars[i] != "\n" { out.append(" "); i += 1 }
                continue
            }
            if chars[i] == "/", i + 1 < chars.count, chars[i + 1] == "*" {
                // Block comments nest in Swift.
                var depth = 0
                while i < chars.count {
                    if chars[i] == "/", i + 1 < chars.count, chars[i + 1] == "*" {
                        depth += 1
                        out += "  "
                        i += 2
                        continue
                    }
                    if chars[i] == "*", i + 1 < chars.count, chars[i + 1] == "/" {
                        depth -= 1
                        out += "  "
                        i += 2
                        if depth == 0 { break }
                        continue
                    }
                    out.append(chars[i] == "\n" ? "\n" : " ")
                    i += 1
                }
                continue
            }
            out.append(chars[i])
            i += 1
        }
        return out
    }

    /// Reads the Swift string literal beginning at `start`, returning its
    /// contents and the index just past the closing quote. Handles `"""` blocks
    /// and backslash escapes; returns nil for an unterminated literal.
    static func stringLiteral(
        in chars: [Character],
        startingAt start: Int
    ) -> (value: String, end: Int)? {
        guard start < chars.count, chars[start] == "\"" else { return nil }

        let isMultiline = start + 2 < chars.count
            && chars[start + 1] == "\""
            && chars[start + 2] == "\""
        let delimiterLength = isMultiline ? 3 : 1

        var value = ""
        var i = start + delimiterLength
        while i < chars.count {
            if chars[i] == "\\" {
                // Keep the backslash: `\(` has to survive for the
                // interpolation stripper to recognise it.
                value.append(chars[i])
                if i + 1 < chars.count { value.append(chars[i + 1]) }
                i += 2
                continue
            }
            if chars[i] == "\"" {
                if isMultiline {
                    if i + 2 < chars.count, chars[i + 1] == "\"", chars[i + 2] == "\"" {
                        return (value, i + 3)
                    }
                } else {
                    return (value, i + 1)
                }
            }
            if !isMultiline, chars[i] == "\n" { return nil }
            value.append(chars[i])
            i += 1
        }
        return nil
    }

    static func lineNumber(of index: Int, in chars: [Character]) -> Int {
        var line = 1
        var i = 0
        while i < index, i < chars.count {
            if chars[i] == "\n" { line += 1 }
            i += 1
        }
        return line
    }
}
