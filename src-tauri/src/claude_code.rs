//! Claude Code (abonnement de l'utilisateur) lancé en mode non interactif comme expert de NozBar.
//!
//! On lance le binaire officiel tel quel : la connexion au compte passe par la procédure d'Anthropic,
//! NozBar ne voit jamais les identifiants. Pas de `--bare` : ce mode n'utilise pas l'abonnement.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Outils utilisables sans demander : lecture, web, et tous les outils NozBar (qui ont leurs propres confirmations).
const ALLOWED_TOOLS: &str = "Read,Glob,Grep,WebSearch,WebFetch,mcp__nozbar";

pub fn build_args(model: &str, resume: Option<&str>, mcp_config: &str, system_prompt: &str) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model", model,
        "--strict-mcp-config",
        "--mcp-config", mcp_config,
        "--permission-prompt-tool", "mcp__nozbar__approve",
        // Écritures dans le dossier de travail sans demander ; le reste passe par la bulle.
        "--permission-mode", "acceptEdits",
        "--allowedTools", ALLOWED_TOOLS,
        "--append-system-prompt", system_prompt,
    ]
    .into_iter()
    .map(String::from)
    .collect();
    if let Some(id) = resume {
        args.extend(["--resume".into(), id.into()]);
    }
    args
}

/// Consignes ajoutées au prompt système de Claude Code.
pub fn system_prompt(workspace: &std::path::Path) -> String {
    [
        "Tu es l'expert de NozBar, un assistant intégré à Windows. L'utilisateur te parle depuis une petite bulle à l'écran.",
        "Réponds en français, en markdown léger, de façon concise : quelques phrases ou une courte liste, sauf si on te demande plus.",
        "Pour interagir avec l'utilisateur, utilise les outils mcp__nozbar__ : ask_user pour une question à choix, \
         get_weather pour la météo, find_file et open_file pour les fichiers, open_app pour lancer une application.",
        &format!("Ton dossier de travail est {} : ranges-y les fichiers que tu crées ou télécharges.", workspace.display()),
        "Les commandes système et les écritures hors de ce dossier demandent une confirmation à l'utilisateur : \
         ne les utilise que si c'est nécessaire.",
    ]
    .join("\n")
}

/// Variables posées par une session Claude Code parente (ex. `tauri dev` lancé depuis Claude Code) :
/// elles changeraient le comportement du Claude Code que NozBar lance.
pub fn is_inherited_claude_var(name: &str) -> bool {
    name == "CLAUDECODE" || name == "CLAUDE_PID" || name.starts_with("CLAUDE_CODE_") || name.starts_with("CLAUDE_AGENT_SDK_")
}

pub fn kill_args(pid: u32) -> [String; 4] {
    ["/PID".into(), pid.to_string(), "/T".into(), "/F".into()]
}

fn find_exe() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from);
    let installed = home.map(|h| h.join(".local").join("bin").join("claude.exe"));
    let on_path = std::env::var_os("PATH").into_iter().flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).flat_map(
        |dir| ["claude.exe", "claude.cmd"].map(|name| dir.join(name)),
    );
    installed.into_iter().chain(on_path).find(|p| p.is_file())
}

/// Dossier de travail de Claude Code : ses téléchargements et fichiers créés y sont rangés.
pub fn workspace() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE").map_err(|e| e.to_string())?;
    let dir = PathBuf::from(home).join("Documents").join("NozBar");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Dossier NozBar impossible à créer : {e}"))?;
    Ok(dir)
}

fn command(exe: &PathBuf) -> Command {
    let mut cmd = Command::new(exe);
    cmd.creation_flags(CREATE_NO_WINDOW);
    for (name, _) in std::env::vars_os() {
        if is_inherited_claude_var(&name.to_string_lossy()) {
            cmd.env_remove(name);
        }
    }
    cmd
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub installed: bool,
    pub logged_in: bool,
}

pub fn status() -> Status {
    let Some(exe) = find_exe() else { return Status { installed: false, logged_in: false } };
    let logged_in = command(&exe)
        .args(["auth", "status"])
        .output()
        .ok()
        .and_then(|out| serde_json::from_slice::<serde_json::Value>(&out.stdout).ok())
        .and_then(|v| v["loggedIn"].as_bool())
        .unwrap_or(false);
    Status { installed: true, logged_in }
}

/// Processus Claude Code en cours, pour pouvoir l'arrêter à la fermeture de la bulle.
#[derive(Default)]
pub struct Running {
    pid: Mutex<Option<u32>>,
}

impl Running {
    pub fn cancel(&self) {
        if let Some(pid) = self.pid.lock().unwrap().take() {
            // Child::kill n'arrêterait que claude.exe, pas les commandes qu'il a lancées.
            let _ = Command::new("taskkill").args(kill_args(pid)).creation_flags(CREATE_NO_WINDOW).output();
        }
    }
}

/// Lance un tour : le message part sur stdin, chaque ligne JSON du flux est transmise à `on_line`.
pub fn run(
    running: &Running,
    prompt: &str,
    args: Vec<String>,
    mut on_line: impl FnMut(String),
) -> Result<(), String> {
    let exe = find_exe().ok_or("Claude Code n'est pas installé")?;
    let mut child = command(&exe)
        .args(args)
        .current_dir(workspace()?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Claude Code ne démarre pas : {e}"))?;
    *running.pid.lock().unwrap() = Some(child.id());

    // Le message passe par stdin : pas de souci de guillemets ni de longueur de ligne de commande.
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes());
    }
    let mut stderr = child.stderr.take();
    let stderr_reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(e) = stderr.as_mut() {
            let _ = e.read_to_string(&mut text);
        }
        text
    });
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                on_line(line);
            }
        }
    }
    let exit = child.wait().map_err(|e| e.to_string())?;
    running.pid.lock().unwrap().take();
    let stderr = stderr_reader.join().unwrap_or_default();
    if exit.success() {
        Ok(())
    } else {
        // Un échec pendant le tour arrive aussi comme résultat sur stdout : l'interface l'a déjà reçu.
        let last = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
        Err(if last.is_empty() { format!("Claude Code s'est arrêté ({exit})") } else { last })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter().position(|a| a == flag).map(|i| args[i + 1].as_str())
    }

    #[test]
    fn builds_a_streaming_run_wired_to_nozbar() {
        let args = build_args("opus", None, "{\"mcpServers\":{}}", "consignes");
        assert_eq!(args[0], "-p");
        assert_eq!(value_after(&args, "--output-format"), Some("stream-json"));
        assert!(args.iter().any(|a| a == "--include-partial-messages"));
        assert_eq!(value_after(&args, "--model"), Some("opus"));
        assert_eq!(value_after(&args, "--mcp-config"), Some("{\"mcpServers\":{}}"));
        assert!(args.iter().any(|a| a == "--strict-mcp-config"));
        assert_eq!(value_after(&args, "--permission-prompt-tool"), Some("mcp__nozbar__approve"));
        assert_eq!(value_after(&args, "--permission-mode"), Some("acceptEdits"));
        assert_eq!(value_after(&args, "--append-system-prompt"), Some("consignes"));
        assert!(value_after(&args, "--resume").is_none());
        // --bare n'utilise pas l'abonnement : il ne doit jamais apparaître.
        assert!(!args.iter().any(|a| a == "--bare"));
    }

    #[test]
    fn resumes_the_bubble_session() {
        let args = build_args("sonnet", Some("abc-123"), "{}", "");
        assert_eq!(value_after(&args, "--resume"), Some("abc-123"));
    }

    #[test]
    fn strips_variables_inherited_from_another_claude_session() {
        for name in ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_AGENT_SDK_VERSION"] {
            assert!(is_inherited_claude_var(name), "{name}");
        }
        assert!(!is_inherited_claude_var("CLAUDE_CONFIG_DIR"));
        assert!(!is_inherited_claude_var("PATH"));
    }

    #[test]
    fn kills_the_whole_process_tree() {
        assert_eq!(kill_args(42), ["/PID", "42", "/T", "/F"]);
    }
}
