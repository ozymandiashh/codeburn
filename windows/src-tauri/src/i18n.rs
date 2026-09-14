//! Localization for the Windows tray (#1336), the twin of `L(_:)` in
//! `mac/Sources/CodeBurnMenubar/Localization.swift`.
//!
//! The two tables under `src/i18n/` are the same files the webview imports
//! (`src/lib/i18n.ts`), so the tray menu and the popover can never disagree
//! about a term. They are seeded verbatim from the menubar's reviewed catalogs,
//! which is what keeps "Today" meaning 今天 on both platforms; the entries only
//! this app renders live in the sections at the end of each file.
//!
//! Keys are the English copy: a key with no translation renders as correct
//! English rather than a visible identifier, and `en` is an identity table
//! kept so the coverage tests below can diff the two. Format specifiers are
//! part of the contract between the tables — `%@` is an already-formatted
//! value (currency, token count, provider name), `%lld` a plain count, `%%` a
//! literal percent sign — and they must stay identical, in the same order, in
//! every locale.
//!
//! Not translated: provider, model and plan names, units, currency codes,
//! shell commands, and anything the `codeburn` CLI produces.
//!
//! The language is resolved once, at launch, from `windows-settings.json` (the
//! file the tray's other preferences live in): `system` follows the Windows UI
//! language. A change takes effect on the next launch, as the mac's picker
//! does — the menu is built before any webview exists, so a mid-run switch
//! would put the two halves of the app in different languages.

use std::collections::BTreeMap;
use std::sync::OnceLock;

/// The raw tables, embedded from the webview's `src/i18n/` so there is exactly
/// one copy of each catalog in the repo.
const EN_TABLE: &str = include_str!("../../src/i18n/en.lproj/Localizable.strings");
const ZH_TABLE: &str = include_str!("../../src/i18n/zh-Hans.lproj/Localizable.strings");

/// The locales shipped. Mirrored by the language picker in the settings window
/// and asserted against the parsed tables by the tests below.
pub const SUPPORTED: &[&str] = &["en", "zh-Hans"];

/// The language the UI renders in, after the `system` choice has been resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiLanguage {
    English,
    ChineseSimplified,
}

impl UiLanguage {
    fn from_tag(tag: &str) -> Option<Self> {
        match tag {
            "en" => Some(Self::English),
            "zh-Hans" => Some(Self::ChineseSimplified),
            _ => None,
        }
    }
}

/// What the Windows UI language says, as one of the two locales we ship. The
/// menubar glossary is Simplified Chinese only, so every Chinese UI variant
/// resolves to it — the same fallback AppKit makes for a zh-Hant user when
/// zh-Hans is the only Chinese localization a bundle carries.
fn system_language() -> UiLanguage {
    #[cfg(target_os = "windows")]
    {
        // GetUserDefaultUILanguage answers the display language, which is what
        // the reader reads, rather than the regional format. The primary
        // language of the LANGID (low ten bits) is 0x04 for every Chinese
        // variant.
        use windows_sys::Win32::Globalization::GetUserDefaultUILanguage;
        let langid = unsafe { GetUserDefaultUILanguage() };
        if (langid & 0x3FF) == 0x04 {
            return UiLanguage::ChineseSimplified;
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Dev builds on macOS/Linux: the Unix locale spells what the Windows
        // display language would say.
        for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
            if let Ok(value) = std::env::var(key) {
                if value.to_ascii_lowercase().starts_with("zh") {
                    return UiLanguage::ChineseSimplified;
                }
            }
        }
    }
    UiLanguage::English
}

/// The language to render in: the persisted choice when it names a locale we
/// ship, else the system language. Read once per lookup of the catalogs; the
/// settings file is small and the tray menu is built once at launch anyway.
fn ui_language() -> UiLanguage {
    let stored = crate::settings::read()
        .get("language")
        .and_then(serde_json::Value::as_str)
        .and_then(UiLanguage::from_tag);
    stored.unwrap_or_else(system_language)
}

fn catalogs() -> &'static BTreeMap<&'static str, BTreeMap<String, String>> {
    static TABLES: OnceLock<BTreeMap<&'static str, BTreeMap<String, String>>> = OnceLock::new();
    TABLES.get_or_init(|| {
        [
            ("en", parse_table(EN_TABLE).expect("the en catalog must parse")),
            ("zh-Hans", parse_table(ZH_TABLE).expect("the zh-Hans catalog must parse")),
        ]
        .into_iter()
        .collect()
    })
}

fn catalog(language: UiLanguage) -> &'static BTreeMap<String, String> {
    catalogs()
        .get(match language {
            UiLanguage::English => "en",
            UiLanguage::ChineseSimplified => "zh-Hans",
        })
        .expect("every supported language has a table")
}

/// Localized copy for `key`, falling back to the key (its English text) when a
/// translation is missing — the contract that makes the key the development
/// language.
pub fn l(key: &str) -> String {
    catalog(ui_language())
        .get(key)
        .cloned()
        .unwrap_or_else(|| key.to_owned())
}

/// Localized format string for `key`, with each `%@` / `%lld` occurrence
/// replaced by the next argument verbatim and `%%` collapsed to a literal
/// percent. The values arrive already formatted; the specifier names come from
/// the shared menubar glossary and only their order is contractual between the
/// two tables.
pub fn lf(key: &str, args: &[&str]) -> String {
    let formatted = l(key);
    let mut out = String::with_capacity(formatted.len());
    let mut rest = formatted.as_str();
    let mut next = args.iter();
    while let Some(percent) = rest.find('%') {
        out.push_str(&rest[..percent]);
        let after = &rest[percent + 1..];
        if let Some(argument) = after.strip_prefix('%') {
            out.push('%');
            rest = argument;
        } else if let Some(argument) = after.strip_prefix('@').or_else(|| after.strip_prefix("lld")) {
            match next.next() {
                Some(value) => out.push_str(value),
                // Fewer arguments than specifiers: leave the specifier visible
                // rather than dropping it, so the bug is legible in the UI.
                None => out.push_str(&rest[percent..percent + if after.starts_with('@') { 2 } else { 4 }]),
            }
            rest = argument;
        } else {
            // A percent that begins no specifier of ours stays literal.
            out.push('%');
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// Parses the OpenStep `.strings` shape the menubar tables use: `/* comment */`
/// blocks, `"key" = "value";` lines, and the `\"` `\\` `\n` `\t` escapes. A
/// trailing entry without its semicolon still parses; anything else fails, so
/// the tests (and therefore CI) are what catch a hand-edited catalog.
fn parse_table(table: &str) -> Result<BTreeMap<String, String>, String> {
    let mut entries = BTreeMap::new();
    let bytes: Vec<char> = table.chars().collect();
    let mut i = 0;
    let len = bytes.len();
    let skip_space = |i: &mut usize| {
        while *i < len {
            match bytes[*i] {
                ' ' | '\n' | '\r' | '\t' => *i += 1,
                '/' if *i + 1 < len && bytes[*i + 1] == '*' => {
                    *i += 2;
                    while *i + 1 < len && !(bytes[*i] == '*' && bytes[*i + 1] == '/') {
                        *i += 1;
                    }
                    *i = (*i + 2).min(len);
                }
                '/' if *i + 1 < len && bytes[*i + 1] == '/' => {
                    while *i < len && bytes[*i] != '\n' {
                        *i += 1;
                    }
                }
                _ => break,
            }
        }
    };
    let read_quoted = |i: &mut usize| -> Option<String> {
        if *i >= len || bytes[*i] != '"' {
            return None;
        }
        *i += 1;
        let mut out = String::new();
        while *i < len && bytes[*i] != '"' {
            if bytes[*i] == '\\' && *i + 1 < len {
                *i += 1;
                match bytes[*i] {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    '"' => out.push('"'),
                    '\\' => out.push('\\'),
                    other => {
                        out.push('\\');
                        out.push(other);
                    }
                }
            } else {
                out.push(bytes[*i]);
            }
            *i += 1;
        }
        if *i >= len {
            return None;
        }
        *i += 1;
        Some(out)
    };
    loop {
        skip_space(&mut i);
        if i >= len {
            break;
        }
        let line = i;
        let Some(key) = read_quoted(&mut i) else {
            return Err(format!("expected a quoted key at char {line}"));
        };
        skip_space(&mut i);
        if i >= len || bytes[i] != '=' {
            return Err(format!("expected `=` after key {key:?} at char {i}"));
        }
        i += 1;
        skip_space(&mut i);
        let Some(value) = read_quoted(&mut i) else {
            return Err(format!("expected a quoted value for key {key:?} at char {i}"));
        };
        skip_space(&mut i);
        if i < len && bytes[i] == ';' {
            i += 1;
        }
        if key.is_empty() {
            return Err("an empty key has no sentence to look up".into());
        }
        entries.insert(key, value);
    }
    Ok(entries)
}

// Width-aware truncation, ported from mac/.../MenubarSecondRow.swift. Chinese
// labels are shorter in characters but wider per glyph, so any bound on text
// the tray shows must count display cells, not characters: `6 小时 2 分` is 8
// characters and 11 cells. The webview's twin (src/lib/i18n.ts) holds the one
// bound the tray has today; these stay available to the Rust side so a future
// one (a badge caption, a notification) cannot be written against `chars()`.

/// Display cells `text` occupies: an East Asian Wide/Fullwidth glyph counts
/// twice. The ranges are the ones the menubar catalog can actually contain;
/// widen them if a locale outside them ships.
pub fn display_cells(text: &str) -> usize {
    text.chars()
        .map(|c| {
            let code = c as u32;
            let wide = (0x1100..=0x115F).contains(&code)
                || (0x2E80..=0xA4CF).contains(&code)
                || (0xAC00..=0xD7A3).contains(&code)
                || (0xF900..=0xFAFF).contains(&code)
                || (0xFE30..=0xFE6F).contains(&code)
                || (0xFF00..=0xFF60).contains(&code)
                || (0xFFE0..=0xFFE6).contains(&code)
                || (0x20000..=0x3FFFD).contains(&code);
            if wide { 2 } else { 1 }
        })
        .sum()
}

/// Shortens `text` to `limit` display cells, marking the cut with an ellipsis.
/// Returns "" when there is no room for even one character plus the mark, so
/// the caller can drop the part entirely rather than render a bare "…".
pub fn abbreviate(text: &str, limit: usize) -> String {
    if display_cells(text) <= limit {
        return text.to_owned();
    }
    if limit < 2 {
        return String::new();
    }
    let mut kept = String::new();
    let mut used = 0;
    for character in text.chars() {
        let width = display_cells(&character.to_string());
        if used + width > limit - 1 {
            break;
        }
        kept.push(character);
        used += width;
    }
    while kept.ends_with(' ') {
        kept.pop();
    }
    if kept.is_empty() {
        String::new()
    } else {
        format!("{kept}…")
    }
}

/// The width-weighted row budget from MenubarSecondRow.swift, in display cells:
/// the tray's analog of the menubar title may not exceed it, so a translated
/// row cannot outgrow the English one in pixels.
pub const SECOND_ROW_CELL_BUDGET: usize = 24;

/// Applies [`SECOND_ROW_CELL_BUDGET`] to an already-composed row.
pub fn clamp_to_row_budget(row: &str) -> String {
    abbreviate(row, SECOND_ROW_CELL_BUDGET)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Specifier occurrences in order, `%%` included — the same scanner the
    /// mac's LocalizationCatalogTests uses, so the contract is spelled
    /// identically on both platforms.
    fn specifiers(value: &str) -> Vec<String> {
        let chars: Vec<char> = value.chars().collect();
        let mut found = Vec::new();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] != '%' {
                i += 1;
                continue;
            }
            i += 1;
            if i >= chars.len() {
                break;
            }
            if chars[i] == '%' {
                found.push("%%".to_owned());
                i += 1;
                continue;
            }
            let mut token = String::from("%");
            while i < chars.len() && "0123456789.+- #'".contains(chars[i]) {
                token.push(chars[i]);
                i += 1;
            }
            while i < chars.len() && "lhqLzjt".contains(chars[i]) {
                token.push(chars[i]);
                i += 1;
            }
            if i < chars.len() {
                token.push(chars[i]);
                i += 1;
            }
            found.push(token);
        }
        found
    }

    /// The specifiers that consume an argument; their order is the contract.
    fn arguments(value: &str) -> Vec<String> {
        specifiers(value)
            .into_iter()
            .filter(|token| token != "%%")
            .collect()
    }

    fn literal_percent_count(value: &str) -> usize {
        specifiers(value).iter().filter(|token| token.as_str() == "%%").count()
    }

    fn table(tag: &str) -> &'static BTreeMap<String, String> {
        catalogs().get(tag).expect("every supported tag has a table")
    }

    /// A translation catalog rots silently: a key added to one table but not
    /// the other shows English in a Chinese UI (or a raw identifier), and a
    /// specifier that disagrees between them is a wrong number at runtime —
    /// none of which a compiler sees. These tests are the only gate, and CI
    /// runs them on both legs of the matrix.
    #[test]
    fn both_catalogs_parse_non_empty() {
        for tag in SUPPORTED {
            assert!(!table(tag).is_empty(), "{tag} parsed empty");
        }
    }

    #[test]
    fn key_sets_match() {
        let en = table("en");
        let zh = table("zh-Hans");
        let untranslated: Vec<_> = en.keys().filter(|k| !zh.contains_key(*k)).collect();
        assert!(
            untranslated.is_empty(),
            "these en keys have no zh-Hans entry: {:?}",
            &untranslated[..untranslated.len().min(10)]
        );
        let orphaned: Vec<_> = zh.keys().filter(|k| !en.contains_key(*k)).collect();
        assert!(
            orphaned.is_empty(),
            "these zh-Hans keys are not in en, so nothing ever reaches them: {:?}",
            &orphaned[..orphaned.len().min(10)]
        );
    }

    #[test]
    fn no_entry_is_blank_in_either_locale() {
        for tag in SUPPORTED {
            let blank: Vec<_> = table(tag)
                .iter()
                .filter(|(_, v)| v.trim().is_empty())
                .map(|(k, _)| k.clone())
                .collect();
            assert!(blank.is_empty(), "blank values in {tag}: {:?}", &blank[..blank.len().min(10)]);
        }
    }

    #[test]
    fn english_is_identity_so_a_missing_translation_degrades_to_english() {
        let mismatched: Vec<_> = table("en").iter().filter(|(k, v)| k != v).map(|(k, _)| k.clone()).collect();
        assert!(
            mismatched.is_empty(),
            "en entries must repeat their key verbatim: {:?}",
            &mismatched[..mismatched.len().min(10)]
        );
    }

    #[test]
    fn argument_specifiers_match_in_count_and_order() {
        for (key, english) in table("en") {
            let Some(chinese) = table("zh-Hans").get(key) else { continue };
            let expected = arguments(english);
            let actual = arguments(chinese);
            assert_eq!(
                expected, actual,
                "specifier mismatch for {key:?}: en {expected:?} vs zh-Hans {actual:?}"
            );
        }
    }

    #[test]
    fn literal_percent_signs_survive_translation() {
        for (key, english) in table("en") {
            let Some(chinese) = table("zh-Hans").get(key) else { continue };
            // `%%` may move (Chinese word order puts the time before the verb),
            // but one side cannot lose it.
            assert_eq!(
                literal_percent_count(english),
                literal_percent_count(chinese),
                "{key:?} carries a different number of literal percent signs across locales"
            );
        }
    }

    #[test]
    fn a_key_is_never_only_specifiers() {
        for key in table("en").keys() {
            let stripped = specifiers(key).iter().fold(key.clone(), |acc, token| {
                acc.replace(token, "")
            });
            assert!(
                !stripped.trim().is_empty(),
                "{key:?} is only specifiers and spaces; a translator has no sentence to work with"
            );
        }
    }

    #[test]
    fn the_shared_glossary_came_through_verbatim() {
        // Spot checks against the menubar's reviewed translations: these are
        // the terms the issue named as the cross-platform contract.
        assert_eq!(table("zh-Hans")["Today"], "今天");
        assert_eq!(table("zh-Hans")["Week"], "本周");
        assert_eq!(table("zh-Hans")["Month"], "本月");
        assert_eq!(table("zh-Hans")["Cost"], "花费");
        assert_eq!(table("zh-Hans")["Calls"], "调用");
        assert_eq!(table("zh-Hans")["Sessions"], "会话");
        assert_eq!(table("zh-Hans")["Capacity Dock"], "容量 Dock");
        assert_eq!(table("zh-Hans")["Settings"], "设置");
    }

    #[test]
    fn lf_substitutes_in_order_and_collapses_literal_percents() {
        // The language of these lookups follows the machine this test runs on,
        // so the assertion goes through the table rather than l(), the same way
        // the mac's tests format out of a named localization.
        let format = table("zh-Hans")["%lld sessions"].clone();
        assert_eq!(lf_in(UiLanguage::ChineseSimplified, "%lld sessions", &["3"]), "3 个会话");
        assert_eq!(format, "%lld 个会话");

        assert_eq!(
            lf_in(UiLanguage::ChineseSimplified, "%@%% cache hit", &["87"]),
            "缓存命中 87%"
        );
        assert_eq!(
            lf_in(UiLanguage::English, "Resets %@", &["in 2h"]),
            "Resets in 2h"
        );
        // A specifier with no argument stays legible rather than vanishing.
        assert_eq!(lf_in(UiLanguage::English, "%@ calls", &[]), "%@ calls");
    }

    /// `lf` against a pinned language, so the assertions do not depend on the
    /// machine's locale.
    fn lf_in(language: UiLanguage, key: &str, args: &[&str]) -> String {
        let format = catalog(language)
            .get(key)
            .cloned()
            .unwrap_or_else(|| key.to_owned());
        let mut out = String::new();
        let mut rest = format.as_str();
        let mut next = args.iter();
        while let Some(percent) = rest.find('%') {
            out.push_str(&rest[..percent]);
            let after = &rest[percent + 1..];
            if let Some(argument) = after.strip_prefix('%') {
                out.push('%');
                rest = argument;
            } else if let Some(argument) = after.strip_prefix('@').or_else(|| after.strip_prefix("lld")) {
                if let Some(value) = next.next() {
                    out.push_str(value);
                } else {
                    out.push_str(if after.starts_with('@') { "%@" } else { "%lld" });
                }
                rest = argument;
            } else {
                out.push('%');
                rest = after;
            }
        }
        out.push_str(rest);
        out
    }

    #[test]
    fn display_cells_counts_a_wide_glyph_as_two() {
        assert_eq!(display_cells("6 小时 2 分"), 11);
        assert_eq!("6 小时 2 分".chars().count(), 8);
        assert_eq!(display_cells("6h 2m"), 5);
    }

    #[test]
    fn abbreviate_marks_the_cut_and_respects_the_cell_budget() {
        assert_eq!(abbreviate("CodeBurn", 24), "CodeBurn");
        assert_eq!(abbreviate("GitHub Copilot", 9), "GitHub C…");
        // The cut is by cells, so a wide glyph never straddles the budget.
        assert_eq!(abbreviate("六小时二分钟", 5), "六小…");
        assert_eq!(abbreviate("anything", 1), "");
        assert_eq!(clamp_to_row_budget("6 小时 2 分"), "6 小时 2 分");
        assert_eq!(clamp_to_row_budget("GitHub Copilot 12% left · 6d 3h"), "GitHub Copilot 12% left…");
    }
}
