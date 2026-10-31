//! Correspondance approximative de noms (applications, fichiers).

/// Seuil sous lequel un nom n'est pas considéré comme correspondant.
pub const MATCH_THRESHOLD: f64 = 0.82;

/// Minuscules, sans accents, uniquement lettres/chiffres séparés par une espace.
/// « HorizonLauncher » est aussi découpé en « horizon launcher ».
pub fn normalize(s: &str) -> String {
    let mut spaced = String::with_capacity(s.len() + 8);
    let mut prev_lower = false;
    for c in s.chars() {
        if c.is_uppercase() && prev_lower {
            spaced.push(' ');
        }
        prev_lower = c.is_lowercase();
        spaced.push(c);
    }
    deunicode::deunicode(&spaced)
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn score(query: &str, key: &str) -> f64 {
    if key == query {
        return 1.0;
    }
    if key.starts_with(query) {
        return 0.95;
    }
    if key.split(' ').any(|w| w.starts_with(query)) {
        return 0.9;
    }
    if key.contains(query) {
        return 0.86;
    }
    let whole = strsim::jaro_winkler(query, key);
    let per_word = key
        .split(' ')
        .map(|w| strsim::jaro_winkler(query, w))
        .fold(0.0, f64::max);
    whole.max(per_word * 0.97)
}
