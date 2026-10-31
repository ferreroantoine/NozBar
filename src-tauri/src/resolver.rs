//! « Ouvre X » : cherche à la fois dans les applications et dans les fichiers, et ne lance
//! que ce qui correspond nettement. En cas de doute, l'interface demande à l'utilisateur.

use serde::Serialize;

use crate::fuzzy::{normalize, score, MATCH_THRESHOLD};

const MAX_CHOICES: usize = 4;
/// Mots qui n'aident pas à identifier la cible.
const STOP_WORDS: &[&str] = &[
    "ouvre", "ouvrir", "lance", "lancer", "le", "la", "les", "l", "mon", "ma", "mes", "un", "une", "de", "du", "des",
    "application", "appli", "app", "logiciel", "programme", "jeu", "fichier",
];
/// Deux mots sont considérés comme le même malgré une faute de frappe au-delà de ce seuil.
const WORD_SIMILARITY: f64 = 0.94;

#[derive(Clone, Debug, Serialize)]
pub struct Candidate {
    pub label: String,
    /// "app" (identifiant du menu Démarrer) ou "file" (chemin complet).
    pub kind: &'static str,
    pub target: String,
    /// Où il se trouve, pour la question posée à l'utilisateur.
    pub detail: String,
    #[serde(skip)]
    key: String,
}

impl Candidate {
    pub fn app(name: &str, app_id: &str) -> Candidate {
        Candidate { label: name.into(), kind: "app", target: app_id.into(), detail: "application".into(), key: normalize(name) }
    }

    pub fn file(name: &str, path: &str, folder: &str) -> Candidate {
        let stem = crate::files::split_ext(name).0;
        Candidate { label: name.into(), kind: "file", target: path.into(), detail: folder.into(), key: normalize(stem) }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "candidates", rename_all = "lowercase")]
pub enum Resolution {
    Open(Candidate),
    Choose(Vec<Candidate>),
    Nothing,
}

/// Mots significatifs de la demande, sans extension dictée (« launcher.exe »).
pub fn query_words(query: &str) -> Vec<String> {
    normalize(crate::files::split_ext(query.trim()).0)
        .split(' ')
        .filter(|w| !w.is_empty() && !STOP_WORDS.contains(w))
        .map(String::from)
        .collect()
}

fn same_word(q: &str, k: &str) -> bool {
    k.starts_with(q) || (k.len() >= 3 && q.starts_with(k)) || strsim::jaro_winkler(q, k) >= WORD_SIMILARITY
}

/// Chaque mot de la demande se retrouve dans le nom : « horizon launcher » couvre « horizon-launcher »,
/// pas « Forza Horizon 6 ».
fn covers(words: &[String], key: &str) -> bool {
    !words.is_empty() && words.iter().all(|w| key.split(' ').any(|k| same_word(w, k)))
}

fn top(mut list: Vec<(f64, Candidate)>) -> Vec<Candidate> {
    list.sort_by(|(a, _), (b, _)| b.partial_cmp(a).unwrap());
    list.into_iter().take(MAX_CHOICES).map(|(_, c)| c).collect()
}

/// Applications du menu Démarrer, puis fichiers seulement si aucune application ne porte ce nom exact
/// (la fouille du disque coûte quelques centaines de millisecondes).
pub fn resolve(query: &str, index: &crate::apps::AppIndex) -> Resolution {
    let apps: Vec<Candidate> = index.entries().iter().map(|a| Candidate::app(&a.name, &a.app_id)).collect();
    let q = query_words(query).join(" ");
    if apps.iter().any(|c| c.key == q) {
        return classify(query, apps, Vec::new());
    }
    let files = crate::files::find(query, crate::files::Kind::Any)
        .iter()
        .map(|f| Candidate::file(&f.name, &f.path, &f.folder))
        .collect();
    classify(query, apps, files)
}

pub fn classify(query: &str, apps: Vec<Candidate>, files: Vec<Candidate>) -> Resolution {
    let words = query_words(query);
    if words.is_empty() {
        return Resolution::Nothing;
    }
    let q = words.join(" ");
    let scored = |list: Vec<Candidate>| -> Vec<(f64, Candidate)> {
        list.into_iter().map(|c| (score(&q, &c.key), c)).collect()
    };
    let (apps, files) = (scored(apps), scored(files));

    // Le nom exact d'une application l'emporte (« spotify » → Spotify, pas « spotify-playlist.txt »).
    if let Some((_, exact)) = apps.iter().find(|(_, c)| c.key == q) {
        return Resolution::Open(exact.clone());
    }
    let (strong_apps, weak_apps): (Vec<_>, Vec<_>) = apps.into_iter().partition(|(_, c)| covers(&words, &c.key));
    // Un raccourci (« Forza Horizon 6.url ») qui porte le nom d'une application est la même cible.
    let files: Vec<_> = files.into_iter().filter(|(_, f)| !strong_apps.iter().any(|(_, a)| a.key == f.key)).collect();
    let (strong_files, weak_files): (Vec<_>, Vec<_>) = files.into_iter().partition(|(_, c)| covers(&words, &c.key));

    if strong_apps.is_empty() {
        if let Some((_, exact)) = strong_files.iter().find(|(_, c)| c.key == q) {
            if strong_files.iter().filter(|(_, c)| c.key == q).count() == 1 {
                return Resolution::Open(exact.clone());
            }
        }
    }
    let strong: Vec<_> = strong_apps.into_iter().chain(strong_files).collect();
    match strong.len() {
        1 => return Resolution::Open(strong.into_iter().next().unwrap().1),
        n if n > 1 => return Resolution::Choose(top(strong)),
        _ => {}
    }
    // Ressemblance partielle seulement : on ne devine pas, on propose.
    let weak: Vec<_> = weak_apps.into_iter().chain(weak_files).filter(|(s, _)| *s >= MATCH_THRESHOLD).collect();
    if weak.is_empty() {
        Resolution::Nothing
    } else {
        Resolution::Choose(top(weak))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(name: &str) -> Candidate {
        Candidate::app(name, name)
    }

    fn file(name: &str) -> Candidate {
        Candidate::file(name, &format!("C:\\Users\\moi\\Downloads\\{name}"), "Téléchargements")
    }

    fn labels(r: &Resolution) -> Vec<&str> {
        match r {
            Resolution::Open(c) => vec![c.label.as_str()],
            Resolution::Choose(list) => list.iter().map(|c| c.label.as_str()).collect(),
            Resolution::Nothing => vec![],
        }
    }

    #[test]
    fn opens_the_file_whose_every_word_matches_instead_of_a_partial_app() {
        let r = classify("horizon launcher", vec![app("Forza Horizon 6")], vec![file("horizon-launcher.exe")]);
        assert!(matches!(r, Resolution::Open(ref c) if c.label == "horizon-launcher.exe"), "{:?}", labels(&r));
        // Faute de frappe et extension dictée.
        let r = classify("horzon launcher.exe", vec![app("Forza Horizon 6")], vec![file("horizon-launcher.exe")]);
        assert!(matches!(r, Resolution::Open(ref c) if c.label == "horizon-launcher.exe"));
    }

    #[test]
    fn asks_when_only_a_partial_match_exists() {
        let r = classify("horizon launcher", vec![app("Forza Horizon 6")], vec![]);
        assert!(matches!(r, Resolution::Choose(_)));
        assert_eq!(labels(&r), ["Forza Horizon 6"]);
    }

    #[test]
    fn asks_between_several_full_matches() {
        let r = classify("launcher", vec![app("Epic Games Launcher")], vec![file("horizon-launcher.exe")]);
        assert!(matches!(r, Resolution::Choose(_)));
        assert_eq!(labels(&r).len(), 2);
    }

    #[test]
    fn an_exact_app_name_wins() {
        let r = classify("spotify", vec![app("Spotify"), app("Spotify Helper")], vec![file("spotify-playlist.txt")]);
        assert!(matches!(r, Resolution::Open(ref c) if c.label == "Spotify"));
        let r = classify("ouvre le spotify", vec![app("Spotify")], vec![]);
        assert!(matches!(r, Resolution::Open(_)));
    }

    #[test]
    fn a_single_full_match_opens_directly() {
        let r = classify("code", vec![app("Visual Studio Code")], vec![]);
        assert!(matches!(r, Resolution::Open(ref c) if c.label == "Visual Studio Code"));
    }

    #[test]
    fn a_shortcut_named_like_an_app_is_not_a_second_choice() {
        let r = classify("forza horizon", vec![app("Forza Horizon 6")], vec![file("Forza Horizon 6.url")]);
        assert!(matches!(r, Resolution::Open(ref c) if c.label == "Forza Horizon 6"), "{:?}", labels(&r));
    }

    #[test]
    fn different_words_are_not_typos() {
        let r = classify("launcher", vec![app("Epic Games Launcher")], vec![file("lancer.bat")]);
        assert!(matches!(r, Resolution::Open(ref c) if c.label == "Epic Games Launcher"), "{:?}", labels(&r));
    }

    #[test]
    fn nothing_when_nothing_looks_alike() {
        assert!(matches!(classify("photoshop", vec![app("Spotify")], vec![file("notes.txt")]), Resolution::Nothing));
        assert!(matches!(classify("", vec![app("Spotify")], vec![]), Resolution::Nothing));
    }

    /// Dépend de la machine : `cargo test --lib real_resolve -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_resolve_on_this_computer() {
        let index = crate::apps::AppIndex::default();
        for q in ["horizon launcher", "horzon launcher il", "forza horizon", "spotify", "launcher", "code"] {
            println!("{q:?} → {:?}", labels(&resolve(q, &index)));
        }
    }

    #[test]
    fn offers_at_most_four_choices() {
        let apps = (1..=6).map(|i| app(&format!("Launcher {i}"))).collect();
        assert_eq!(labels(&classify("launcher", apps, vec![])).len(), 4);
    }
}
