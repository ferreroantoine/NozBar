mod apps;
mod claude_code;
mod files;
mod fuzzy;
mod location;
mod mcp;
mod resolver;
mod running_apps;
mod secrets;
mod system;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

use apps::AppIndex;

/// Au-delà de ce délai, un appui maintenu sur le raccourci passe en push-to-talk.
const PTT_DELAY: Duration = Duration::from_millis(280);
/// Position verticale de la bulle, en fraction de la hauteur du moniteur.
const BUBBLE_TOP_RATIO: f64 = 0.18;

#[derive(Default)]
struct HotkeyState {
    press_id: u64,
    pressed: bool,
    was_visible: bool,
    ptt: bool,
}

#[derive(Default)]
struct AppState {
    hotkey: Mutex<HotkeyState>,
    shortcut_label: Mutex<String>,
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

/// Place la bulle sur le moniteur du curseur, centrée horizontalement, puis l'affiche.
fn show_bubble(win: &WebviewWindow) {
    if let Ok(cursor) = win.cursor_position() {
        if let (Ok(Some(monitor)), Ok(size)) = (win.monitor_from_point(cursor.x, cursor.y), win.outer_size()) {
            let (mp, ms) = (monitor.position(), monitor.size());
            let x = mp.x + (ms.width as i32 - size.width as i32) / 2;
            let y = mp.y + (ms.height as f64 * BUBBLE_TOP_RATIO) as i32;
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    }
    let _ = win.show();
    let _ = win.set_focus();
}

fn on_shortcut_pressed(app: &AppHandle) {
    let Some(win) = main_window(app) else { return };
    let visible = win.is_visible().unwrap_or(false);
    let id = {
        let state = app.state::<AppState>();
        let mut hk = state.hotkey.lock().unwrap();
        if hk.pressed {
            return; // répétition clavier
        }
        hk.pressed = true;
        hk.ptt = false;
        hk.was_visible = visible;
        hk.press_id += 1;
        hk.press_id
    };

    if !visible {
        show_bubble(&win);
        let _ = app.emit("bubble:open", ());
    }

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(PTT_DELAY);
        let state = app.state::<AppState>();
        let mut hk = state.hotkey.lock().unwrap();
        if hk.pressed && hk.press_id == id {
            hk.ptt = true;
            drop(hk);
            if let Some(win) = main_window(&app) {
                let _ = win.set_focus();
            }
            let _ = app.emit("ptt:start", ());
        }
    });
}

fn on_shortcut_released(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut hk = state.hotkey.lock().unwrap();
    hk.pressed = false;
    if hk.ptt {
        hk.ptt = false;
        drop(hk);
        let _ = app.emit("ptt:end", ());
    } else if hk.was_visible {
        // Appui court alors que la bulle était ouverte : on la referme.
        drop(hk);
        let _ = app.emit("bubble:close", ());
    }
}

fn register_shortcut(app: &AppHandle) -> Result<String, String> {
    let candidates = [
        (Shortcut::new(Some(Modifiers::ALT), Code::Space), "Alt+Espace"),
        (Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space), "Ctrl+Alt+Espace"),
    ];
    let mut errors = Vec::new();
    for (shortcut, label) in candidates {
        match app.global_shortcut().register(shortcut) {
            Ok(()) => return Ok(label.to_string()),
            Err(e) => errors.push(format!("{label}: {e}")),
        }
    }
    Err(errors.join("; "))
}

#[cfg(windows)]
fn hide_from_alt_tab(win: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TOOLWINDOW};
    if let Ok(handle) = win.hwnd() {
        // tauri et notre crate `windows` n'ont pas forcément la même version : on passe par le pointeur brut.
        let hwnd = HWND(handle.0 as _);
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW.0 as isize);
        }
    }
}

// ---------- Commandes appelées par le front ----------

#[tauri::command]
fn hide_bubble(window: WebviewWindow) {
    let _ = window.hide();
}

/// Une application qui vient de s'ouvrir a pris le focus : la bulle le reprend et reste au-dessus.
#[tauri::command]
fn focus_bubble(window: WebviewWindow) {
    let _ = window.set_always_on_top(true);
    system::with_alt_held(|| {
        let _ = window.set_focus();
    });
}

#[tauri::command]
fn get_shortcut(state: tauri::State<AppState>) -> String {
    state.shortcut_label.lock().unwrap().clone()
}

#[tauri::command]
fn get_api_key(provider: String) -> Result<Option<String>, String> {
    secrets::get(&provider)
}

#[tauri::command]
fn set_api_key(provider: String, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return secrets::delete(&provider);
    }
    secrets::set(&provider, key)
}

#[derive(Serialize)]
struct LaunchedApp {
    name: String,
}

#[tauri::command]
async fn open_app(name: String, index: tauri::State<'_, AppIndex>) -> Result<LaunchedApp, String> {
    let entry = index
        .find(&name)
        .ok_or_else(|| format!("Aucune application ne correspond à « {name} »"))?;
    system::shell_open(&format!("shell:AppsFolder\\{}", entry.app_id))?;
    Ok(LaunchedApp { name: entry.name })
}

#[tauri::command]
async fn find_files(query: String, kind: Option<String>) -> Result<Vec<files::Candidate>, String> {
    // Le parcours du disque peut prendre une seconde : hors du fil d'exécution des commandes.
    tauri::async_runtime::spawn_blocking(move || files::find(&query, files::Kind::parse(kind.as_deref())))
        .await
        .map_err(|e| e.to_string())
}

// Accès disque potentiellement lents (disque réveillé, antivirus) : jamais sur le fil principal.
#[tauri::command]
async fn check_file(path: String) -> Result<files::FileCheck, String> {
    tauri::async_runtime::spawn_blocking(move || files::check(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_file(path: String, confirmed: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || files::open(&path, confirmed))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn claude_code_status() -> Result<claude_code::Status, String> {
    tauri::async_runtime::spawn_blocking(claude_code::status).await.map_err(|e| e.to_string())
}

/// Un tour de Claude Code : chaque ligne JSON du flux part vers l'interface par `on_line`.
#[tauri::command]
async fn claude_code_send(
    app: AppHandle,
    prompt: String,
    model: String,
    resume: Option<String>,
    on_line: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let server = app.state::<Arc<mcp::McpServer>>();
        let workspace = claude_code::workspace()?;
        let args = claude_code::build_args(
            &model,
            resume.as_deref(),
            &server.config_json(),
            &claude_code::system_prompt(&workspace),
        );
        claude_code::run(&app.state::<claude_code::Running>(), &prompt, args, |line| {
            let _ = on_line.send(line);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn claude_code_cancel(running: tauri::State<claude_code::Running>) {
    running.cancel();
}

#[tauri::command]
fn mcp_set_tools(tools: Vec<serde_json::Value>, server: tauri::State<Arc<mcp::McpServer>>) {
    server.set_tools(tools);
}

#[tauri::command]
fn mcp_reply(id: u64, text: String, is_error: bool, server: tauri::State<Arc<mcp::McpServer>>) {
    server.reply(id, mcp::ToolOutcome { text, is_error });
}

#[tauri::command]
async fn get_location() -> Result<location::Position, String> {
    tauri::async_runtime::spawn_blocking(location::locate)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn resolve_open(app: AppHandle, query: String) -> Result<resolver::Resolution, String> {
    tauri::async_runtime::spawn_blocking(move || resolver::resolve(&query, &app.state::<AppIndex>()))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn resolve_close(query: String) -> Result<resolver::Resolution, String> {
    tauri::async_runtime::spawn_blocking(move || running_apps::resolve(&query)).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn close_app(target: String) -> Result<usize, String> {
    running_apps::close(&target)
}

/// Seuls les identifiants de l'index sont acceptés : pas de `shell:` arbitraire.
#[tauri::command]
fn launch_app(app_id: String, index: tauri::State<AppIndex>) -> Result<(), String> {
    if !index.contains_id(&app_id) {
        return Err("Application inconnue".into());
    }
    system::shell_open(&format!("shell:AppsFolder\\{app_id}"))
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    system::open_url(&url)
}

#[tauri::command]
fn open_settings(page: String) -> Result<(), String> {
    system::open_settings(&page)
}

#[tauri::command]
fn media_control(action: String) -> Result<(), String> {
    system::media_control(&action)
}

#[tauri::command]
async fn set_volume(level: Option<i32>, delta: Option<i32>) -> Result<u32, String> {
    system::set_volume(level, delta)
}

#[tauri::command]
fn set_timer(app: AppHandle, seconds: u64, title: String, body: String) -> Result<(), String> {
    if seconds == 0 || seconds > 24 * 3600 {
        return Err("Durée invalide (1 s à 24 h)".into());
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(seconds));
        let _ = app.notification().builder().title(title).body(body).show();
    });
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = main_window(app) {
                show_bubble(&win);
                let _ = app.emit("bubble:open", ());
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| match event.state() {
                    ShortcutState::Pressed => on_shortcut_pressed(app),
                    ShortcutState::Released => on_shortcut_released(app),
                })
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .manage(AppIndex::default())
        .manage(claude_code::Running::default())
        // L'état de la souris et du clavier se lit ici, au moment même de la perte de focus :
        // l'interface reçoit l'événement trop tard, le bouton serait déjà relâché.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(false) = event {
                let (mouse, keys) = system::input_state();
                let _ = window.emit("bubble:blur", serde_json::json!({ "mouse": mouse, "keys": keys }));
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // Serveur MCP local : Claude Code y trouve les outils de NozBar.
            let emitter = handle.clone();
            let server = mcp::McpServer::start(Box::new(move |id, name, args| {
                let _ = emitter.emit("mcp:call", serde_json::json!({ "id": id, "name": name, "args": args }));
            }))?;
            app.manage(server);

            // L'index des applications prend 1 à 2 s : on le construit en arrière-plan.
            let indexer = handle.clone();
            std::thread::spawn(move || {
                if let Err(e) = indexer.state::<AppIndex>().refresh() {
                    eprintln!("[apps] indexation impossible : {e}");
                }
            });

            match register_shortcut(&handle) {
                Ok(label) => *app.state::<AppState>().shortcut_label.lock().unwrap() = label,
                Err(e) => eprintln!("[hotkey] aucun raccourci disponible : {e}"),
            }

            if let Some(win) = main_window(&handle) {
                #[cfg(windows)]
                hide_from_alt_tab(&win);
            }

            let open = MenuItem::with_id(app, "open", "Ouvrir NozBar", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("icône manquante"))
                .tooltip("NozBar")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(win) = main_window(app) {
                            show_bubble(&win);
                            let _ = app.emit("bubble:open", ());
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hide_bubble,
            focus_bubble,
            get_shortcut,
            get_api_key,
            set_api_key,
            open_app,
            resolve_open,
            launch_app,
            resolve_close,
            close_app,
            find_files,
            check_file,
            open_file,
            get_location,
            mcp_set_tools,
            mcp_reply,
            claude_code_status,
            claude_code_send,
            claude_code_cancel,
            open_url,
            open_settings,
            media_control,
            set_volume,
            set_timer,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au démarrage de NozBar");
}
