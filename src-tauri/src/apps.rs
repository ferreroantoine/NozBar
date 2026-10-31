//! Index des applications du menu Démarrer (bureau + Store) et lancement par nom.
//!
//! `Get-StartApps` énumère `shell:AppsFolder`, qui couvre les raccourcis classiques
//! comme les applications UWP/MSIX. On lance ensuite via `shell:AppsFolder\<AppID>`.

use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::fuzzy::{normalize, score, MATCH_THRESHOLD};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Deserialize)]
struct StartApp {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "AppID")]
    app_id: String,
}

#[derive(Clone, Serialize)]
pub struct AppEntry {
    pub name: String,
    pub app_id: String,
    #[serde(skip)]
    key: String,
}

#[derive(Default)]
pub struct AppIndex {
    apps: Mutex<Vec<AppEntry>>,
}

impl AppIndex {
    pub fn refresh(&self) -> Result<usize, String> {
        let apps = load_start_apps()?;
        let count = apps.len();
        *self.apps.lock().unwrap() = apps;
        Ok(count)
    }

    fn is_empty(&self) -> bool {
        self.apps.lock().unwrap().is_empty()
    }

    /// Toutes les applications connues (sans les désinstalleurs).
    pub fn entries(&self) -> Vec<AppEntry> {
        if self.is_empty() {
            let _ = self.refresh();
        }
        self.apps.lock().unwrap().iter().filter(|a| !is_uninstaller(&a.key)).cloned().collect()
    }

    pub fn contains_id(&self, app_id: &str) -> bool {
        self.apps.lock().unwrap().iter().any(|a| a.app_id == app_id)
    }

    pub fn find(&self, query: &str) -> Option<AppEntry> {
        if self.is_empty() {
            let _ = self.refresh();
        }
        let found = best_match(&self.apps.lock().unwrap(), query);
        if found.is_some() {
            return found;
        }
        // L'application vient peut-être d'être installée.
        self.refresh().ok()?;
        best_match(&self.apps.lock().unwrap(), query)
    }
}

fn load_start_apps() -> Result<Vec<AppEntry>, String> {
    let script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; \
                  Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress";
    let out = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("powershell: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let text = text.trim().trim_start_matches('\u{feff}');
    // ConvertTo-Json renvoie un objet seul (et non un tableau) s'il n'y a qu'une app.
    let raw: Vec<StartApp> = serde_json::from_str(text)
        .or_else(|_| serde_json::from_str::<StartApp>(text).map(|a| vec![a]))
        .map_err(|e| format!("Get-StartApps JSON: {e}"))?;
    Ok(raw
        .into_iter()
        .map(|a| AppEntry {
            key: normalize(&a.name),
            name: a.name,
            app_id: a.app_id,
        })
        .collect())
}

fn best_match(apps: &[AppEntry], query: &str) -> Option<AppEntry> {
    let q = normalize(query);
    if q.is_empty() {
        return None;
    }
    apps.iter()
        .filter(|a| !is_uninstaller(&a.key))
        .map(|a| (score(&q, &a.key), a))
        .filter(|(s, _)| *s >= MATCH_THRESHOLD)
        // À score égal, le nom le plus court est le plus probable ("Spotify" avant "Spotify Helper").
        .max_by(|(sa, a), (sb, b)| {
            sa.partial_cmp(sb)
                .unwrap()
                .then_with(|| b.key.len().cmp(&a.key.len()))
        })
        .map(|(_, a)| a.clone())
}

fn is_uninstaller(key: &str) -> bool {
    ["uninstall", "desinstall", "remove"]
        .iter()
        .any(|w| key.contains(w))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str) -> AppEntry {
        AppEntry {
            name: name.into(),
            app_id: name.into(),
            key: normalize(name),
        }
    }

    #[test]
    fn picks_expected_apps() {
        let apps = vec![
            entry("Spotify"),
            entry("Uninstall Spotify"),
            entry("Visual Studio Code"),
            entry("Calculatrice"),
            entry("Microsoft Edge"),
        ];
        assert_eq!(best_match(&apps, "spotify").unwrap().name, "Spotify");
        assert_eq!(best_match(&apps, "Spotifi").unwrap().name, "Spotify");
        assert_eq!(best_match(&apps, "code").unwrap().name, "Visual Studio Code");
        assert_eq!(best_match(&apps, "calculatrice").unwrap().name, "Calculatrice");
        assert_eq!(best_match(&apps, "edge").unwrap().name, "Microsoft Edge");
        assert!(best_match(&apps, "photoshop").is_none());
    }
}
