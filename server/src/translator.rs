//! Translation fan-out: translate one text into many target languages in
//! parallel, returning a `{ lang: text }` map (including the source language,
//! unchanged). Wraps the Groq client.

use std::collections::HashMap;

use crate::groq::Groq;

/// Fan-out translator over a cloneable Groq client.
#[derive(Clone)]
pub struct Translator {
    groq: Groq,
}

impl Translator {
    pub fn new(groq: Groq) -> Self {
        Self { groq }
    }

    /// Translate `text` from `source_lang` into each of `target_langs` in
    /// parallel. The returned map always contains the source language mapped to
    /// the original text; failed individual translations are simply omitted.
    pub async fn translate_fanout(
        &self,
        text: &str,
        source_lang: &str,
        target_langs: &[String],
    ) -> HashMap<String, String> {
        let mut translations = HashMap::new();
        translations.insert(source_lang.to_string(), text.to_string());

        let mut tasks = Vec::new();
        for tgt in target_langs {
            if tgt == source_lang {
                continue;
            }
            let groq = self.groq.clone();
            let text = text.to_string();
            let src = source_lang.to_string();
            let tgt = tgt.clone();
            tasks.push(tokio::spawn(async move {
                (tgt.clone(), groq.translate(&text, &src, &tgt).await)
            }));
        }

        for task in tasks {
            if let Ok((lang, Ok(translated))) = task.await {
                translations.insert(lang, translated);
            }
        }
        translations
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::groq::Groq;

    #[tokio::test]
    async fn fanout_includes_source_and_skips_same_lang() {
        let tr = Translator::new(Groq::new("dummy-key".into()));
        // No targets -> just the source text, no network call.
        let m = tr.translate_fanout("ciao", "it", &[]).await;
        assert_eq!(m.get("it").map(String::as_str), Some("ciao"));
        assert_eq!(m.len(), 1);
        // target == source is skipped (still no network).
        let m2 = tr.translate_fanout("ciao", "it", &["it".to_string()]).await;
        assert_eq!(m2.len(), 1);
    }
}
