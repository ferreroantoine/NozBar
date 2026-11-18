//! Lancement de NozBar à l'ouverture de la session Windows (clé « Run » de l'utilisateur, sans droits admin).

use crate::registry::{delete_value, read_string, write_string, HKEY_CURRENT_USER};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE: &str = "NozBar";

fn command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(format!("\"{}\"", exe.display()))
}

/// Activé seulement s'il lance bien cet exécutable (pas une ancienne installation déplacée).
pub fn is_enabled() -> bool {
    let current = command().ok();
    read_string(HKEY_CURRENT_USER, RUN_KEY, VALUE).is_some_and(|v| Some(v) == current)
}

pub fn set_enabled(enabled: bool) -> Result<(), String> {
    if enabled {
        write_string(HKEY_CURRENT_USER, RUN_KEY, VALUE, &command()?)
    } else {
        delete_value(HKEY_CURRENT_USER, RUN_KEY, VALUE)
    }
}
