//! Room glossary (spec 0011): per-room term pairs injected into the translation
//! prompt so domain terminology is translated exactly as the room decided.
//!
//! Glossaries are keyed by the room code (rooms are ephemeral TEXT codes — no
//! rooms table) and persist across calls that reuse the same code. The
//! translation hot path never touches the database: [`GlossaryService::get`]
//! populates a `DashMap` cache at room join, mutations refresh it, and the
//! per-utterance [`GlossaryService::cached`] read is synchronous.

use std::collections::HashSet;
use std::sync::Arc;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::Pool;

/// Cap on term pairs injected into a single translation prompt (after the
/// source/target language filter), protecting real-time latency. The stored
/// glossary may be larger (`GLOSSARY_MAX_ENTRIES`).
pub const MAX_INJECTED: usize = 50;

/// One stored term pair, as served to the client editor.
#[derive(Debug, Clone, Serialize)]
pub struct GlossaryEntry {
    pub id: Uuid,
    pub source_lang: String,
    pub target_lang: String,
    pub source_term: String,
    pub target_term: String,
}

/// A term pair as submitted by the client (no id yet). Also the CSV row shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewEntry {
    pub source_lang: String,
    pub target_lang: String,
    pub source_term: String,
    pub target_term: String,
}

/// A room's full glossary, cached as one immutable snapshot.
#[derive(Debug, Default, Serialize)]
pub struct RoomGlossary {
    pub name: Option<String>,
    pub entries: Vec<GlossaryEntry>,
}

impl RoomGlossary {
    /// Term pairs for one (source → target) language direction, capped at
    /// [`MAX_INJECTED`]. This is the per-utterance filter: only terms whose
    /// `source_lang` matches the speaker's language are ever injected.
    pub fn terms_for(&self, source_lang: &str, target_lang: &str) -> Vec<(String, String)> {
        self.entries
            .iter()
            .filter(|e| e.source_lang == source_lang && e.target_lang == target_lang)
            .take(MAX_INJECTED)
            .map(|e| (e.source_term.clone(), e.target_term.clone()))
            .collect()
    }
}

/// Trim + validate + dedupe a glossary payload (shared by the JSON save path
/// and CSV import). Language codes are lowercased; on a duplicate
/// `(source_lang, target_lang, source_term)` key the **last** occurrence wins,
/// so an import overrides existing rows. Errors are user-facing 400 messages.
pub fn normalize_entries(raw: Vec<NewEntry>, max: usize) -> Result<Vec<NewEntry>, String> {
    let mut cleaned = Vec::with_capacity(raw.len());
    for (i, mut e) in raw.into_iter().enumerate() {
        let n = i + 1;
        e.source_lang = e.source_lang.trim().to_lowercase();
        e.target_lang = e.target_lang.trim().to_lowercase();
        e.source_term = e.source_term.trim().to_string();
        e.target_term = e.target_term.trim().to_string();
        if e.source_lang.is_empty() || e.target_lang.is_empty() {
            return Err(format!("entry {n}: missing language code"));
        }
        if e.source_lang.len() > 10 || e.target_lang.len() > 10 {
            return Err(format!("entry {n}: language code too long"));
        }
        if e.source_lang == e.target_lang {
            return Err(format!("entry {n}: source and target language are the same"));
        }
        if e.source_term.is_empty() || e.target_term.is_empty() {
            return Err(format!("entry {n}: empty term"));
        }
        if e.source_term.chars().count() > 200 || e.target_term.chars().count() > 200 {
            return Err(format!("entry {n}: term too long (max 200 chars)"));
        }
        cleaned.push(e);
    }

    // Last-wins dedupe on the DB unique key (room, source_lang, target_lang,
    // source_term): walk backwards keeping first-seen, then restore order.
    let mut seen = HashSet::new();
    let mut deduped: Vec<NewEntry> = cleaned
        .into_iter()
        .rev()
        .filter(|e| {
            seen.insert((
                e.source_lang.clone(),
                e.target_lang.clone(),
                e.source_term.clone(),
            ))
        })
        .collect();
    deduped.reverse();

    if deduped.len() > max {
        return Err(format!("too many entries (max {max})"));
    }
    Ok(deduped)
}

/// Parse glossary CSV: one `source_lang,target_lang,source_term,target_term`
/// row per line. Fields may be double-quoted (with `""` escaping a quote) so
/// terms can contain commas; all fields are trimmed. Blank lines are skipped,
/// as is a leading header row. Errors carry the 1-based line number;
/// validation happens later in [`normalize_entries`].
pub fn import_csv(csv: &str) -> Result<Vec<NewEntry>, String> {
    let mut out = Vec::new();
    let mut first_row = true;
    for (i, line) in csv.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let fields = split_csv_line(line);
        if first_row {
            first_row = false;
            if fields
                .first()
                .is_some_and(|f| f.eq_ignore_ascii_case("source_lang"))
            {
                continue; // header row
            }
        }
        if fields.len() != 4 {
            return Err(format!(
                "line {}: expected 4 fields (source_lang,target_lang,source_term,target_term), got {}",
                i + 1,
                fields.len()
            ));
        }
        let mut f = fields.into_iter();
        out.push(NewEntry {
            source_lang: f.next().unwrap_or_default(),
            target_lang: f.next().unwrap_or_default(),
            source_term: f.next().unwrap_or_default(),
            target_term: f.next().unwrap_or_default(),
        });
    }
    Ok(out)
}

/// Split one CSV line into trimmed fields. Minimal quoting: a field wrapped in
/// double quotes may contain commas; `""` inside quotes is a literal quote.
fn split_csv_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut chars = line.trim_end_matches('\r').chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if in_quotes => {
                if chars.peek() == Some(&'"') {
                    cur.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            }
            // An opening quote (only counts at the start of a field).
            '"' if cur.trim().is_empty() => {
                cur.clear();
                in_quotes = true;
            }
            ',' if !in_quotes => fields.push(std::mem::take(&mut cur).trim().to_string()),
            _ => cur.push(c),
        }
    }
    fields.push(cur.trim().to_string());
    fields
}

/// Glossary persistence + cache. Cloneable: the `DashMap` is shared, so every
/// clone sees the same snapshots.
#[derive(Clone)]
pub struct GlossaryService {
    pool: Pool,
    cache: Arc<DashMap<String, Arc<RoomGlossary>>>,
    max_entries: usize,
}

impl GlossaryService {
    pub fn new(pool: Pool, max_entries: usize) -> Self {
        Self {
            pool,
            cache: Arc::new(DashMap::new()),
            max_entries,
        }
    }

    pub fn max_entries(&self) -> usize {
        self.max_entries
    }

    /// Synchronous cache read for the per-utterance hot path. `None` only when
    /// the room was never loaded this process lifetime (no one joined it).
    pub fn cached(&self, room: &str) -> Option<Arc<RoomGlossary>> {
        self.cache.get(room).map(|g| g.clone())
    }

    /// Cache-or-load (used at room join). A room with no glossary caches an
    /// empty snapshot so the hot path stays DB-free either way.
    pub async fn get(&self, room: &str) -> Result<Arc<RoomGlossary>, sqlx::Error> {
        if let Some(g) = self.cached(room) {
            return Ok(g);
        }
        self.reload(room).await
    }

    /// Load fresh from the database and refresh the cache (after mutations).
    pub async fn reload(&self, room: &str) -> Result<Arc<RoomGlossary>, sqlx::Error> {
        let name: Option<Option<String>> =
            sqlx::query_scalar("SELECT name FROM room_glossaries WHERE room = $1")
                .bind(room)
                .fetch_optional(&self.pool)
                .await?;
        // Alphabetical order is the canonical (and stable) editor order:
        // batch-inserted rows share a created_at, so it can't order them.
        let rows: Vec<(Uuid, String, String, String, String)> = sqlx::query_as(
            "SELECT id, source_lang, target_lang, source_term, target_term \
             FROM glossary_entries WHERE room = $1 \
             ORDER BY source_lang, target_lang, lower(source_term)",
        )
        .bind(room)
        .fetch_all(&self.pool)
        .await?;
        let glossary = Arc::new(RoomGlossary {
            name: name.flatten(),
            entries: rows
                .into_iter()
                .map(
                    |(id, source_lang, target_lang, source_term, target_term)| GlossaryEntry {
                        id,
                        source_lang,
                        target_lang,
                        source_term,
                        target_term,
                    },
                )
                .collect(),
        });
        self.cache.insert(room.to_string(), glossary.clone());
        Ok(glossary)
    }

    /// Replace the room's glossary (header + all entries) in one transaction,
    /// then refresh the cache. `entries` must already be normalized.
    pub async fn save(
        &self,
        room: &str,
        name: Option<&str>,
        entries: &[NewEntry],
        created_by: Uuid,
    ) -> Result<Arc<RoomGlossary>, sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO room_glossaries (room, name, created_by) VALUES ($1, $2, $3) \
             ON CONFLICT (room) DO UPDATE SET name = EXCLUDED.name, updated_at = now()",
        )
        .bind(room)
        .bind(name)
        .bind(created_by)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM glossary_entries WHERE room = $1")
            .bind(room)
            .execute(&mut *tx)
            .await?;
        for e in entries {
            sqlx::query(
                "INSERT INTO glossary_entries \
                 (room, source_lang, target_lang, source_term, target_term) \
                 VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(room)
            .bind(&e.source_lang)
            .bind(&e.target_lang)
            .bind(&e.source_term)
            .bind(&e.target_term)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        self.reload(room).await
    }

    /// Delete the room's glossary (entries cascade) and cache the empty state.
    pub async fn delete(&self, room: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM room_glossaries WHERE room = $1")
            .bind(room)
            .execute(&self.pool)
            .await?;
        self.cache
            .insert(room.to_string(), Arc::new(RoomGlossary::default()));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(sl: &str, tl: &str, st: &str, tt: &str) -> NewEntry {
        NewEntry {
            source_lang: sl.into(),
            target_lang: tl.into(),
            source_term: st.into(),
            target_term: tt.into(),
        }
    }

    #[test]
    fn terms_for_filters_by_direction_and_caps() {
        let mut entries: Vec<GlossaryEntry> = (0..60)
            .map(|i| GlossaryEntry {
                id: Uuid::new_v4(),
                source_lang: "it".into(),
                target_lang: "en".into(),
                source_term: format!("termine{i}"),
                target_term: format!("term{i}"),
            })
            .collect();
        entries.push(GlossaryEntry {
            id: Uuid::new_v4(),
            source_lang: "en".into(),
            target_lang: "it".into(),
            source_term: "deck".into(),
            target_term: "presentazione".into(),
        });
        let g = RoomGlossary {
            name: None,
            entries,
        };
        // Only the matching direction, capped at MAX_INJECTED.
        assert_eq!(g.terms_for("it", "en").len(), MAX_INJECTED);
        assert_eq!(
            g.terms_for("en", "it"),
            vec![("deck".to_string(), "presentazione".to_string())]
        );
        // No match in either unrelated direction.
        assert!(g.terms_for("it", "fr").is_empty());
        assert!(g.terms_for("fr", "en").is_empty());
    }

    #[test]
    fn normalize_trims_lowercases_and_dedupes_last_wins() {
        let out = normalize_entries(
            vec![
                entry(" IT ", " EN ", "  fattura  ", "invoice"),
                entry("it", "en", "preventivo", "quote"),
                // Same key as the first row (after trim/lowercase) — wins.
                entry("it", "en", "fattura", "bill"),
            ],
            200,
        )
        .unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], entry("it", "en", "preventivo", "quote"));
        assert_eq!(out[1], entry("it", "en", "fattura", "bill"));
    }

    #[test]
    fn normalize_rejects_bad_entries() {
        // Empty language.
        let e = normalize_entries(vec![entry("", "en", "a", "b")], 10).unwrap_err();
        assert!(e.contains("entry 1"), "{e}");
        // Same source and target language.
        let e = normalize_entries(vec![entry("en", "EN", "a", "b")], 10).unwrap_err();
        assert!(e.contains("same"), "{e}");
        // Empty term (whitespace only).
        let e = normalize_entries(vec![entry("it", "en", "   ", "b")], 10).unwrap_err();
        assert!(e.contains("empty term"), "{e}");
        // Term over 200 chars.
        let long = "x".repeat(201);
        let e = normalize_entries(vec![entry("it", "en", &long, "b")], 10).unwrap_err();
        assert!(e.contains("too long"), "{e}");
        // Entry index is 1-based and points at the offender.
        let e = normalize_entries(
            vec![entry("it", "en", "ok", "ok"), entry("it", "en", "", "b")],
            10,
        )
        .unwrap_err();
        assert!(e.contains("entry 2"), "{e}");
    }

    #[test]
    fn normalize_caps_after_dedupe() {
        // 3 raw rows, 2 after dedupe — fits a max of 2.
        let rows = vec![
            entry("it", "en", "a", "1"),
            entry("it", "en", "a", "2"),
            entry("it", "en", "b", "3"),
        ];
        assert_eq!(normalize_entries(rows.clone(), 2).unwrap().len(), 2);
        let e = normalize_entries(rows, 1).unwrap_err();
        assert!(e.contains("too many entries (max 1)"), "{e}");
    }

    #[test]
    fn csv_parses_rows_header_and_blank_lines() {
        let csv = "source_lang,target_lang,source_term,target_term\r\n\
                   it,en,fattura,invoice\n\
                   \n\
                   en,it,deck,presentazione\n";
        let out = import_csv(csv).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], entry("it", "en", "fattura", "invoice"));
        assert_eq!(out[1], entry("en", "it", "deck", "presentazione"));
        // No header is also fine — the first row only skips when it IS one.
        let out = import_csv("it,en,fattura,invoice").unwrap();
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn csv_quoted_fields_keep_commas_and_escaped_quotes() {
        let csv = r#"it,en,"sale, tasse incluse","total, tax included""ish""""#;
        let out = import_csv(csv).unwrap();
        assert_eq!(out[0].source_term, "sale, tasse incluse");
        assert_eq!(out[0].target_term, "total, tax included\"ish\"");
        // A quote mid-field (not at the start) stays literal.
        let out = import_csv("it,en,l'IVA,the VAT").unwrap();
        assert_eq!(out[0].source_term, "l'IVA");
    }

    #[test]
    fn csv_wrong_field_count_reports_line_number() {
        let csv = "it,en,fattura,invoice\nit,en,solo-tre";
        let e = import_csv(csv).unwrap_err();
        assert!(e.contains("line 2"), "{e}");
        assert!(e.contains("got 3"), "{e}");
        // Too many fields errors too (a stray comma must not silently drop data).
        let e = import_csv("it,en,a,b,c").unwrap_err();
        assert!(e.contains("line 1") && e.contains("got 5"), "{e}");
    }

    #[test]
    fn csv_empty_input_yields_no_entries() {
        assert!(import_csv("").unwrap().is_empty());
        assert!(import_csv("\n  \n").unwrap().is_empty());
        // A header-only file is empty as well.
        assert!(import_csv("source_lang,target_lang,source_term,target_term")
            .unwrap()
            .is_empty());
    }
}
