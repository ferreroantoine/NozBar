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

/// Documents et médias ouverts sans confirmation. Tout le reste (programmes, scripts,
/// raccourcis, documents à macros, extensions inconnues) passe par une confirmation.
const OPEN_DIRECTLY: &[&str] = &[
    "pdf", "txt", "md", "rtf", "csv", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "epub",
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "tif", "tiff",
    "mp3", "wav", "flac", "m4a", "ogg", "aac", "mp4", "mkv", "avi", "mov", "webm", "wmv",
    "zip", "7z", "rar",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCheck {
    /// Nom réel du fichier, tel que Windows le résout.
    pub name: String,
    pub needs_confirmation: bool,
    #[serde(skip)]
    path: PathBuf,
}

/// `\\?\C:\…` → `C:\…` : ShellExecute et certains programmes refusent le préfixe étendu.
fn plain(path: &Path) -> String {
    let s = path.to_string_lossy();
    s.strip_prefix(r"\\?\").filter(|rest| !rest.starts_with("UNC")).unwrap_or(&s).to_string()
}

/// Résout le chemin réel (Windows ignore les points et espaces finaux : « outil.exe. » est « outil.exe »),
/// vérifie qu'il est dans un dossier fouillé, et décide si l'ouverture demande une confirmation.
pub fn resolve(path: &str, roots: &[PathBuf]) -> Result<FileCheck, String> {
    // Avant tout accès disque : un chemin réseau enverrait les identifiants Windows au serveur.
    if path.starts_with(r"\\") || path.starts_with("//") {
        return Err("Les chemins réseau ne peuvent pas être ouverts".into());
    }
    let real = std::fs::canonicalize(path).map_err(|_| format!("Fichier introuvable : {path}"))?;
    if !real.is_file() {
        return Err(format!("Ce n'est pas un fichier : {path}"));
    }
    let inside = roots
        .iter()
        .filter_map(|r| std::fs::canonicalize(r).ok())
        .any(|r| real.starts_with(r));
    if !inside {
        return Err("Seuls les fichiers de Téléchargements, Bureau et Documents peuvent être ouverts".into());
    }
    let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = split_ext(&name).1.to_ascii_lowercase();
    Ok(FileCheck { name, needs_confirmation: !OPEN_DIRECTLY.contains(&ext.as_str()), path: real })
}

fn search_roots() -> Vec<PathBuf> {
    roots().into_iter().map(|(p, _)| p).collect()
}

pub fn check(path: &str) -> Result<FileCheck, String> {
    resolve(path, &search_roots())
}

/// `confirmed` : l'utilisateur a validé l'ouverture. La règle est revérifiée ici, pas seulement côté interface.
pub fn open(path: &str, confirmed: bool) -> Result<(), String> {
    let file = resolve(path, &search_roots())?;
    if file.needs_confirmation && !confirmed {
        return Err(format!("{} demande une confirmation avant d'être ouvert", file.name));
    }
    crate::system::shell_open(&plain(&file.path))
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

    /// Dossier racine temporaire avec quelques fichiers vides.
    fn sandbox(files: &[&str]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nozbar-files-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for f in files {
            std::fs::write(dir.join(f), b"").unwrap();
        }
        dir
    }

    #[test]
    fn trailing_dot_cannot_hide_a_program() {
        let root = sandbox(&["outil.exe", "rapport.pdf", "macro.docm", "sansext"]);
        let at = |name: &str| root.join(name).to_string_lossy().into_owned();
        let roots = [root.clone()];
        assert!(resolve(&format!("{}.", at("outil.exe")), &roots).unwrap().needs_confirmation);
        assert!(resolve(&format!("{}. .", at("outil.exe")), &roots).unwrap().needs_confirmation);
        assert!(!resolve(&at("rapport.pdf"), &roots).unwrap().needs_confirmation);
        // Ce qui n'est pas un document connu demande confirmation (macros, sans extension…).
        assert!(resolve(&at("macro.docm"), &roots).unwrap().needs_confirmation);
        assert!(resolve(&at("sansext"), &roots).unwrap().needs_confirmation);
    }

    #[test]
    fn refuses_paths_outside_the_searched_folders() {
        let root = sandbox(&["rapport.pdf"]);
        let other = std::env::temp_dir();
        assert!(resolve(&root.join("rapport.pdf").to_string_lossy(), &[other.join("ailleurs")]).is_err());
        assert!(resolve(r"\\serveur\partage\rapport.pdf", &[root.clone()]).is_err());
        assert!(resolve("//serveur/partage/rapport.pdf", &[root]).is_err());
    }

    #[test]
    fn skips_noise_directories() {
        for dir in [".git", "node_modules", "$RECYCLE.BIN", ".cache"] {
            assert!(is_skipped_dir(dir), "{dir}");
        }
        assert!(!is_skipped_dir("Factures"));
    }
}
