//! Réglages de NozBar (permissions de Claude Code, souvenirs), enregistrés dans `settings.json`.
//! Les clés API n'y sont jamais : elles restent dans le Gestionnaire d'identification.

use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Policy {
    Always,
    Ask,
    Never,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Permissions {
    pub web_search: Policy,
    pub web_fetch: Policy,
    pub read_outside: Policy,
    pub write_outside: Policy,
    pub commands: Policy,
    pub programs: Policy,
}

impl Default for Permissions {
    fn default() -> Self {
        Permissions {
            web_search: Policy::Always,
            web_fetch: Policy::Always,
            read_outside: Policy::Ask,
            write_outside: Policy::Ask,
            commands: Policy::Ask,
            programs: Policy::Ask,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub permissions: Permissions,
    /// Ce que l'utilisateur a demandé de retenir (« souviens-toi que… »), rappelé à chaque conversation.
    pub memories: Vec<String>,
}

/// Fichier absent ou illisible : valeurs par défaut (jamais d'erreur au démarrage).
pub fn load(path: &Path) -> Settings {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("Réglages impossibles à enregistrer : {e}"))
}

/// Outils que Claude Code utilise sans demander. « Demander » et « Refuser » passent par l'outil
/// `approve` du pont MCP, qui applique la règle (refuser par `--disallowedTools Write` bloquerait
/// aussi les écritures dans le dossier de travail de Claude).
pub fn allowed_tools(p: &Permissions) -> String {
    let groups: [(Policy, &[&str]); 5] = [
        (p.web_search, &["WebSearch"]),
        (p.web_fetch, &["WebFetch"]),
        (p.read_outside, &["Read", "Glob", "Grep"]),
        (p.write_outside, &["Write", "Edit", "MultiEdit", "NotebookEdit"]),
        (p.commands, &["Bash", "PowerShell"]),
    ];
    groups
        .iter()
        .filter(|(policy, _)| *policy == Policy::Always)
        .flat_map(|(_, tools)| tools.iter().copied())
        .chain(["mcp__nozbar"])
        .collect::<Vec<_>>()
        .join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_ask_for_anything_risky() {
        let p = Permissions::default();
        assert_eq!(p.web_search, Policy::Always);
        assert_eq!(p.web_fetch, Policy::Always);
        assert_eq!(p.read_outside, Policy::Ask);
        assert_eq!(p.write_outside, Policy::Ask);
        assert_eq!(p.commands, Policy::Ask);
        assert_eq!(p.programs, Policy::Ask);
    }

    #[test]
    fn missing_or_broken_file_gives_defaults() {
        let dir = std::env::temp_dir().join(format!("nozbar-settings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let _ = std::fs::remove_file(&path);
        assert_eq!(load(&path), Settings::default());
        std::fs::write(&path, "{ pas du json").unwrap();
        assert_eq!(load(&path), Settings::default());
        // Champ manquant (ancienne version) : la valeur par défaut le complète.
        std::fs::write(&path, r#"{"permissions":{"commands":"always"}}"#).unwrap();
        let s = load(&path);
        assert_eq!(s.permissions.commands, Policy::Always);
        assert_eq!(s.permissions.read_outside, Policy::Ask);
    }

    #[test]
    fn saves_and_reloads() {
        let dir = std::env::temp_dir().join(format!("nozbar-settings-save-{}", std::process::id()));
        let path = dir.join("settings.json");
        let mut s = Settings::default();
        s.permissions.write_outside = Policy::Never;
        save(&path, &s).unwrap();
        assert_eq!(load(&path), s);
    }

    #[test]
    fn always_rules_become_allowed_tools() {
        let mut p = Permissions::default();
        assert_eq!(allowed_tools(&p), "WebSearch,WebFetch,mcp__nozbar");
        p.commands = Policy::Always;
        p.read_outside = Policy::Always;
        p.web_fetch = Policy::Never;
        assert_eq!(allowed_tools(&p), "WebSearch,Read,Glob,Grep,Bash,PowerShell,mcp__nozbar");
    }
}
