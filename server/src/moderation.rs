//! Lightweight, deterministic transcript moderation — a first safety layer.
//!
//! It flags a finalized transcript that contains a term from a blocklist (whole
//! word, case-insensitive). It's intentionally simple and configurable
//! (`MODERATION_BLOCKLIST`, comma-separated) — a curated list or an AI classifier
//! can replace/augment it later. When a transcript is flagged, the server drops
//! its broadcast (it isn't shown/translated to the room) and warns the speaker.

use std::collections::HashSet;

/// How bad a piece of text is. `None` passes; `Severe` is blocked + warned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    None,
    Severe,
}

/// A small built-in baseline. Production should set `MODERATION_BLOCKLIST` to a
/// curated list (this is only a non-exhaustive default so the feature does
/// something out of the box).
const DEFAULT_TERMS: &[&str] = &["nigger", "faggot", "retard", "kike", "chink"];

/// Holds the normalized blocklist and checks transcripts against it.
#[derive(Clone, Default)]
pub struct Moderator {
    terms: HashSet<String>,
}

impl Moderator {
    /// Build from the built-in default plus any `MODERATION_BLOCKLIST` env terms.
    pub fn from_env() -> Self {
        let mut m = Self::from_terms(DEFAULT_TERMS.iter().copied());
        if let Ok(extra) = std::env::var("MODERATION_BLOCKLIST") {
            for t in extra.split(',') {
                let t = t.trim().to_lowercase();
                if !t.is_empty() {
                    m.terms.insert(t);
                }
            }
        }
        m
    }

    /// Build from an explicit list of terms (used by tests).
    pub fn from_terms<'a, I: IntoIterator<Item = &'a str>>(terms: I) -> Self {
        Self {
            terms: terms
                .into_iter()
                .map(|t| t.trim().to_lowercase())
                .filter(|t| !t.is_empty())
                .collect(),
        }
    }

    /// Classify a transcript. Matching is whole-word (alphanumeric runs), so
    /// "assassin" never trips a substring like "ass".
    pub fn severity(&self, text: &str) -> Severity {
        if self.terms.is_empty() {
            return Severity::None;
        }
        let lower = text.to_lowercase();
        for token in lower.split(|c: char| !c.is_alphanumeric()) {
            if !token.is_empty() && self.terms.contains(token) {
                return Severity::Severe;
            }
        }
        Severity::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_blocklisted_words_case_and_punctuation_insensitive() {
        let m = Moderator::from_terms(["BadWord", "slur2"]);
        assert_eq!(m.severity("this is fine"), Severity::None);
        assert_eq!(m.severity("you badword!"), Severity::Severe);
        assert_eq!(m.severity("BADWORD"), Severity::Severe);
        assert_eq!(m.severity("a, b. slur2?"), Severity::Severe);
    }

    #[test]
    fn whole_word_only_no_substring_false_positives() {
        let m = Moderator::from_terms(["ass"]);
        assert_eq!(m.severity("the assassin classic passage"), Severity::None);
        assert_eq!(m.severity("don't be an ass"), Severity::Severe);
    }

    #[test]
    fn empty_blocklist_passes_everything() {
        let m = Moderator::from_terms(std::iter::empty::<&str>());
        assert_eq!(m.severity("anything at all"), Severity::None);
    }
}
