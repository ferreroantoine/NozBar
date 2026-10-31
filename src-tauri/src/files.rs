//! Recherche approximative de fichiers dans les dossiers personnels, puis ouverture.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::fuzzy;

const MAX_DEPTH: usize = 3;
const MAX_ENTRIES: usize = 20_000;
const MAX_RESULTS: usize = 5;

/// Extensions lancées comme des programmes : elles demandent une confirmation côté interface.
const PROGRAM_EXTENSIONS: &[&str] = &[
    "exe", "msi", "msix", "appx", "bat", "cmd", "ps1", "vbs", "js", "jse", "wsf", "scr", "com", "lnk", "reg",
    "jar", "hta", "cpl", "appref-ms",
];

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Any,
    Program,
    Document,
}

impl Kind {
    pub fn parse(s: Option<&str>) -> Kind {
        match s {
            Some("program") => Kind::Program,
            Some("document") => Kind::Document,
            _ => Kind::Any,
        }
    }
}

#[derive(Clone, Serialize)]
pub struct Candidate {
    pub name: String,
    pub path: String,
    pub folder: String,
    /// Secondes depuis l'époque Unix.
    pub modified: u64,
}

fn split_ext(name: &str) -> (&str, &str) {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && (1..=9).contains(&ext.len()) => (stem, ext),
        _ => (name, ""),
    }
}

fn is_program(name: &str) -> bool {
    let ext = split_ext(name).1.to_ascii_lowercase();
    PROGRAM_EXTENSIONS.contains(&ext.as_str())
}

pub fn is_skipped_dir(name: &str) -> bool {
    name.starts_with('.') || name.starts_with('$') || matches!(name, "node_modules" | "AppData")
}

/// Meilleures correspondances : score décroissant, puis plus récent d'abord.
pub fn rank(files: &[Candidate], query: &str, kind: Kind) -> Vec<Candidate> {
    // « horizon launcher.exe » : l'extension dictée ne doit pas pénaliser le score.
    let q = fuzzy::normalize(split_ext(query.trim()).0);
    if q.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(f64, &Candidate)> = files
        .iter()
        .filter(|f| match kind {
            Kind::Any => true,
            Kind::Program => is_program(&f.name),
            Kind::Document => !is_program(&f.name),
        })
        .map(|f| (fuzzy::score(&q, &fuzzy::normalize(split_ext(&f.name).0)), f))
        .filter(|(s, _)| *s >= fuzzy::MATCH_THRESHOLD)
        .collect();
    scored.sort_by(|(sa, a), (sb, b)| sb.partial_cmp(sa).unwrap().then_with(|| b.modified.cmp(&a.modified)));
    scored.into_iter().take(MAX_RESULTS).map(|(_, f)| f.clone()).collect()
}

fn roots() -> Vec<(PathBuf, &'static str)> {
    let Ok(home) = std::env::var("USERPROFILE") else { return Vec::new() };
    let home = PathBuf::from(home);
    [
        ("Downloads", "Téléchargements"),
        ("Desktop", "Bureau"),
        ("Documents", "Documents"),
        ("OneDrive\\Desktop", "Bureau"),
        ("OneDrive\\Documents", "Documents"),
    ]
    .into_iter()
    .map(|(sub, label)| (home.join(sub), label))
    .filter(|(p, _)| p.is_dir())
    .collect()
}

/// Parcours itératif, borné en profondeur et en nombre d'entrées.
fn collect(root: &Path, label: &str, out: &mut Vec<Candidate>, budget: &mut usize) {
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if *budget == 0 {
                return;
            }
            *budget -= 1;
            let Ok(file_type) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if file_type.is_dir() {
                if depth < MAX_DEPTH && !is_skipped_dir(&name) {
                    stack.push((entry.path(), depth + 1));
                }
            } else if file_type.is_file() || file_type.is_symlink() {
                let modified = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_secs());
                out.push(Candidate { name, path: entry.path().to_string_lossy().into_owned(), folder: label.into(), modified });
            }
        }
    }
}

pub fn find(query: &str, kind: Kind) -> Vec<Candidate> {
    let mut files = Vec::new();
    let mut budget = MAX_ENTRIES;
    for (root, label) in roots() {
        collect(&root, label, &mut files, &mut budget);
    }
    rank(&files, query, kind)
}

pub fn open(path: &str) -> Result<(), String> {
    if !Path::new(path).is_file() {
        return Err(format!("Fichier introuvable : {path}"));
    }
    crate::system::shell_open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, modified: u64) -> Candidate {
        Candidate {
            name: name.into(),
            path: format!("C:\\Users\\moi\\Downloads\\{name}"),
            folder: "Téléchargements".into(),
            modified,
        }
    }

    fn names(found: &[Candidate]) -> Vec<&str> {
        found.iter().map(|c| c.name.as_str()).collect()
    }

    #[test]
    fn finds_dictated_names() {
        let files = vec![file("facture-horizon.pdf", 3), file("HorizonLauncher.exe", 1), file("notes.txt", 2)];
        assert_eq!(names(&rank(&files, "horzon launcher", Kind::Any))[0], "HorizonLauncher.exe");
        assert_eq!(names(&rank(&files, "horzon launcher.exe", Kind::Any))[0], "HorizonLauncher.exe");
        assert!(rank(&files, "photoshop", Kind::Any).is_empty());

        // Cas réel : l'archive téléchargée à côté du programme extrait.
        let files = vec![file("horizon-launcher-windows-x64.zip", 9), file("horizon-launcher.exe", 1)];
        assert_eq!(names(&rank(&files, "horzon launcher", Kind::Any))[0], "horizon-launcher.exe");
    }

    #[test]
    fn filters_by_kind() {
        let files = vec![file("facture-horizon.pdf", 3), file("HorizonLauncher.exe", 1)];
        assert_eq!(names(&rank(&files, "horizon", Kind::Program)), ["HorizonLauncher.exe"]);
        assert_eq!(names(&rank(&files, "horizon", Kind::Document)), ["facture-horizon.pdf"]);
    }

    #[test]
    fn newest_first_on_equal_score() {
        let files = vec![file("rapport.pdf", 1), file("rapport.docx", 5)];
        assert_eq!(names(&rank(&files, "rapport", Kind::Any)), ["rapport.docx", "rapport.pdf"]);
    }

    #[test]
    fn skips_noise_directories() {
        for dir in [".git", "node_modules", "$RECYCLE.BIN", ".cache"] {
            assert!(is_skipped_dir(dir), "{dir}");
        }
        assert!(!is_skipped_dir("Factures"));
    }
}
