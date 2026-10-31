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

/// `allowed` : outils autorisés sans demander, selon les réglages (voir `settings::allowed_tools`).
pub fn build_args(model: &str, resume: Option<&str>, mcp_config: &str, system_prompt: &str, allowed: &str) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model", model,
        // Ni réglages globaux ni réglages du dossier : leurs règles « allow » contourneraient la bulle.
        "--setting-sources=",
        "--strict-mcp-config",
        "--mcp-config", mcp_config,
        "--permission-prompt-tool", "mcp__nozbar__approve",
        // Écritures dans le dossier de travail sans demander ; le reste passe par la bulle.
        "--permission-mode", "acceptEdits",
        "--allowedTools", allowed,
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
         get_weather pour la météo, find_file et open_file pour les fichiers, open_app pour lancer une application, close_app pour en fermer une. \
         Préfère toujours ces outils à une commande système : ils sont plus sûrs et plus simples à valider.",
        &format!("Ton dossier de travail est {} : ranges-y les fichiers que tu crées ou télécharges.", workspace.display()),
        "Les commandes système et les écritures hors de ce dossier demandent une confirmation à l'utilisateur : \
         ne les utilise que si c'est nécessaire.",
    ]
    // Une seule ligne : un saut de ligne casserait l'argument si Claude Code est installé en .cmd (npm).
    .join(" ")
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

/// Connexion au compte Claude par la procédure officielle, dans une console visible :
/// elle ouvre le navigateur et peut demander de coller un code.
pub fn login() -> Result<(), String> {
    let exe = find_exe().ok_or("Claude Code n'est pas installé")?;
    let mut cmd = Command::new("cmd");
    cmd.creation_flags(CREATE_NO_WINDOW).args(["/c", "start", "Connexion à Claude"]).arg(&exe).args(["auth", "login"]);
    for (name, _) in std::env::vars_os() {
        if is_inherited_claude_var(&name.to_string_lossy()) {
            cmd.env_remove(name);
        }
    }
    cmd.spawn().map(|_| ()).map_err(|e| format!("Connexion impossible à lancer : {e}"))
}

pub fn logout() -> Result<(), String> {
    let exe = find_exe().ok_or("Claude Code n'est pas installé")?;
    command(&exe).args(["auth", "logout"]).output().map(|_| ()).map_err(|e| e.to_string())
}

/// Processus Claude Code en cours, pour pouvoir l'arrêter à la fermeture de la bulle.
#[derive(Default)]
pub struct Running {
    pid: Mutex<Option<u32>>,
}

impl Running {
    fn started(&self, pid: u32) {
        *self.pid.lock().unwrap() = Some(pid);
    }

    /// Un ancien tour qui se termine ne doit pas effacer le processus du tour suivant.
    fn finished(&self, pid: u32) {
        let mut current = self.pid.lock().unwrap();
        if *current == Some(pid) {
            *current = None;
        }
    }

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
    // Un seul tour à la fois : un tour précédent encore vivant (annulé mais pas encore tué) est arrêté.
    running.cancel();
    let mut child = command(&exe)
        .args(args)
        .current_dir(workspace()?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Claude Code ne démarre pas : {e}"))?;
    let pid = child.id();
    running.started(pid);

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
        // Octets bruts puis conversion tolérante : une ligne mal encodée ne doit pas arrêter la lecture
        // (le processus resterait bloqué sur un tuyau plein).
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        while reader.read_until(b'\n', &mut buf).unwrap_or(0) > 0 {
            let line = String::from_utf8_lossy(&buf).trim().to_string();
            if !line.is_empty() {
                on_line(line);
            }
            buf.clear();
        }
    }
    let exit = child.wait().map_err(|e| e.to_string())?;
    running.finished(pid);
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
        let args = build_args("opus", None, "{\"mcpServers\":{}}", "consignes", "WebSearch,mcp__nozbar");
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
    fn ignores_the_users_global_claude_settings_and_gates_reads() {
        let args = build_args("sonnet", None, "{}", "", &crate::settings::allowed_tools(&Default::default()));
        // Les règles « allow » des réglages globaux contourneraient la confirmation dans la bulle.
        assert!(args.iter().any(|a| a == "--setting-sources="));
        // Lire hors du dossier de travail passe par la bulle : lecture libre + WebFetch = fuite possible.
        let allowed = value_after(&args, "--allowedTools").unwrap();
        assert!(!allowed.split(',').any(|t| t == "Read" || t == "Glob" || t == "Grep"), "{allowed}");
    }

    #[test]
    fn system_prompt_fits_on_one_line() {
        // Un saut de ligne casserait l'argument si Claude Code est installé en .cmd (npm).
        assert!(!system_prompt(std::path::Path::new("C:\\x")).contains('\n'));
    }

    #[test]
    fn an_old_run_does_not_forget_the_new_process() {
        let running = Running::default();
        running.started(200);
        running.finished(100);
        assert_eq!(*running.pid.lock().unwrap(), Some(200));
        running.finished(200);
        assert_eq!(*running.pid.lock().unwrap(), None);
    }

    #[test]
    fn resumes_the_bubble_session() {
        let args = build_args("sonnet", Some("abc-123"), "{}", "", "mcp__nozbar");
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

    /// Bout en bout avec le vrai Claude Code (compte connecté requis, consomme un peu d'abonnement) :
    /// `cargo test --lib real_claude_code -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_claude_code_uses_nozbar_tools_and_asks_permission() {
        use crate::mcp::{McpServer, ToolOutcome};
        use std::sync::{Arc, OnceLock};

        let server_cell: Arc<OnceLock<Arc<McpServer>>> = Arc::new(OnceLock::new());
        let calls: Arc<Mutex<Vec<String>>> = Arc::default();
        let (cell, log) = (server_cell.clone(), calls.clone());
        let server = McpServer::start(Box::new(move |id, name, args| {
            log.lock().unwrap().push(format!("{name} {args}"));
            let text = match name {
                "get_time" => "Il est 13 h 37".to_string(),
                // Format attendu par Claude Code pour une autorisation.
                _ => serde_json::json!({ "behavior": "allow", "updatedInput": args["input"] }).to_string(),
            };
            cell.get().unwrap().reply(id, ToolOutcome { text, is_error: false });
        }))
        .unwrap();
        server.set_tools(vec![serde_json::json!({
            "name": "get_time",
            "description": "Donne l'heure actuelle",
            "inputSchema": { "type": "object", "properties": {} }
        })]);
        let _ = server_cell.set(server.clone());

        let running = Running::default();
        let probe = std::env::temp_dir().join("nozbar-probe.txt");
        let prompt = format!(
            "Appelle l'outil get_time. Ensuite exécute avec Bash la commande `echo nozbar-ok > \"{}\"`. \
             Réponds en une phrase avec l'heure et si la commande a réussi.",
            probe.display().to_string().replace('\\', "/")
        );
        let prompt = prompt.as_str();
        let args = build_args("haiku", None, &server.config_json(), "Réponds en français.", "mcp__nozbar");
        let mut result = String::new();
        let started = std::time::Instant::now();
        run(&running, prompt, args, |line| {
            if line.contains("\"type\":\"result\"") {
                result = line;
            }
        })
        .unwrap();
        println!("durée : {:?}", started.elapsed());
        for c in calls.lock().unwrap().iter() {
            println!("appel MCP : {c}");
        }
        let result: serde_json::Value = serde_json::from_str(&result).unwrap();
        println!("résultat : {} | {}", result["subtype"], result["result"]);
        println!("refus : {}", result["permission_denials"]);
        println!("fichier écrit : {}", probe.is_file());
        let _ = std::fs::remove_file(&probe);
        assert!(calls.lock().unwrap().iter().any(|c| c.starts_with("get_time")));
    }
}
