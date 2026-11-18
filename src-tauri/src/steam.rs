//! Jeux Steam installés : « lance Rocket League » sans raccourci dans le menu Démarrer.

use crate::registry::{read_string, HKEY_CURRENT_USER};
use crate::resolver::{classify, Candidate, Resolution};

/// Outils de Steam installés comme des jeux, jamais lancés par l'utilisateur.
const NOT_GAMES: &[&str] = &["redistributable", "proton", "steam linux runtime", "steamworks", "steamvr"];

#[derive(Debug, PartialEq)]
pub struct Game {
    pub name: String,
    pub app_id: String,
}

/// Valeurs d'une clé dans un fichier VDF de Steam (`"clé"  "valeur"`).
fn vdf_values(text: &str, key: &str) -> Vec<String> {
    let quoted = format!("\"{key}\"");
    text.lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix(&quoted)?.trim();
            let value = rest.strip_prefix('"')?.strip_suffix('"')?;
            Some(value.replace("\\\\", "\\"))
        })
        .collect()
}

fn libraries() -> Vec<String> {
    let Some(steam) = read_string(HKEY_CURRENT_USER, r"Software\Valve\Steam", "SteamPath") else { return Vec::new() };
    let steam = steam.replace('/', "\\");
    let mut list = vec![steam.clone()];
    if let Ok(vdf) = std::fs::read_to_string(format!("{steam}\\steamapps\\libraryfolders.vdf")) {
        list.extend(vdf_values(&vdf, "path"));
    }
    let mut seen = std::collections::HashSet::new();
    list.retain(|p| seen.insert(p.to_lowercase()));
    list
}

fn parse_manifest(text: &str) -> Option<Game> {
    let name = vdf_values(text, "name").into_iter().next()?;
    let app_id = vdf_values(text, "appid").into_iter().next()?;
    let lower = name.to_lowercase();
    if NOT_GAMES.iter().any(|n| lower.contains(n)) || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(Game { name, app_id })
}

pub fn games() -> Vec<Game> {
    let mut out = Vec::new();
    for library in libraries() {
        let Ok(entries) = std::fs::read_dir(format!("{library}\\steamapps")) else { continue };
        for entry in entries.flatten() {
            let file = entry.file_name().to_string_lossy().to_string();
            if !(file.starts_with("appmanifest_") && file.ends_with(".acf")) {
                continue;
            }
            if let Some(game) = std::fs::read_to_string(entry.path()).ok().as_deref().and_then(parse_manifest) {
                out.push(game);
            }
        }
    }
    out
}

pub fn resolve(query: &str) -> Resolution {
    let list = games().iter().map(|g| Candidate::named(&g.name, &g.name, "game", &g.app_id, "jeu Steam")).collect();
    classify(query, list, Vec::new())
}

/// Seuls les jeux installés sont acceptés : pas d'URL `steam://` arbitraire.
pub fn launch(app_id: &str) -> Result<(), String> {
    if !games().iter().any(|g| g.app_id == app_id) {
        return Err("Ce jeu n'est pas installé".into());
    }
    crate::system::shell_open(&format!("steam://rungameid/{app_id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_steam_manifests() {
        let manifest = "\"AppState\"\n{\n\t\"appid\"\t\t\"252950\"\n\t\"name\"\t\t\"Rocket League\"\n}";
        assert_eq!(parse_manifest(manifest), Some(Game { name: "Rocket League".into(), app_id: "252950".into() }));
        let tool = "\"AppState\"\n{\n\t\"appid\"\t\t\"228980\"\n\t\"name\"\t\t\"Steamworks Common Redistributables\"\n}";
        assert_eq!(parse_manifest(tool), None);
        let folders = "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"D:\\\\SteamLibrary\"\n\t}\n}";
        assert_eq!(vdf_values(folders, "path"), vec!["D:\\SteamLibrary".to_string()]);
    }

    /// Dépend de la machine : `cargo test --lib real_games -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_games() {
        let games = games();
        println!("{} jeux : {:?}", games.len(), games.iter().map(|g| g.name.as_str()).collect::<Vec<_>>());
        if let Ok(Some(media)) = crate::system::now_playing() {
            println!("lecture en cours dans {} ({})", media.app, if media.playing { "lecture" } else { "pause" });
        }
    }
}
