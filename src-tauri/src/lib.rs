mod apps;
mod autostart;
mod browser;
mod claude_code;
mod devices;
mod files;
mod fuzzy;
mod location;
mod mcp;
mod power;
mod registry;
mod resolver;
mod running_apps;
mod screen;
mod secrets;
mod settings;
mod steam;
mod system;
mod window_control;

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
/// Les deux raccourcis possibles (Alt+Espace, Ctrl+Alt+Espace) finissent par Espace.
const SHORTCUT_KEY: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY =
    windows::Win32::UI::Input::KeyboardAndMouse::VK_SPACE;
const KEY_POLL: Duration = Duration::from_millis(20);
/// Assez fréquent pour ne rater aucun clic, assez rare pour ne rien coûter.
const OUTSIDE_POLL: Duration = Duration::from_millis(25);
/// Assez pour un menu Démarrer bien rempli, sans alourdir chaque transcription.
const SPEECH_HINTS_MAX: usize = 400;

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
    /// Fenêtre au premier plan juste avant l'ouverture de la bulle : celle que l'utilisateur regardait.
    previous_window: Mutex<isize>,
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

/// Place la bulle sur le moniteur du curseur, centrée horizontalement, puis l'affiche.
fn show_bubble(win: &WebviewWindow) {
    remember_previous_window(win);
    if let Ok(cursor) = win.cursor_position() {
        if let (Ok(Some(monitor)), Ok(size)) = (win.monitor_from_point(cursor.x, cursor.y), win.outer_size()) {
            let (mp, ms) = (monitor.position(), monitor.size());
            let x = mp.x + (ms.width as i32 - size.width as i32) / 2;
            // En haut de l'écran : la marge de 14 px vient de la page (.stage).
            let _ = win.set_position(PhysicalPosition::new(x, mp.y));
        }
    }
    let _ = win.show();
    let _ = win.set_focus();
    watch_outside(win);
}

/// Windows refuse souvent le focus à la bulle quand elle s'ouvre par-dessus une autre application :
/// elle ne le « perd » alors jamais, et ni un clic ailleurs ni Échap ne la fermaient. Tant qu'elle est
/// affichée, on surveille donc nous-mêmes les clics hors de la bulle, et Échap quand elle n'a pas le focus
/// (avec le focus, la page gère Échap elle-même : elle annule d'abord une question en cours).
fn watch_outside(win: &WebviewWindow) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::UI::Input::KeyboardAndMouse::{VK_ESCAPE, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetForegroundWindow, GetWindowRect};

    static WATCHING: AtomicBool = AtomicBool::new(false);
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    let win = win.clone();
    std::thread::spawn(move || {
        let (mut mouse_was_down, mut escape_was_down) = (true, true);
        while win.is_visible().unwrap_or(false) {
            let Ok(handle) = win.hwnd() else { break };
            let hwnd = HWND(handle.0 as _);
            let mouse = [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON].into_iter().any(system::key_down);
            let escape = system::key_down(VK_ESCAPE);
            if mouse && !mouse_was_down {
                let (mut cursor, mut rect) = (POINT::default(), RECT::default());
                let outside = unsafe { GetCursorPos(&mut cursor).is_ok() && GetWindowRect(hwnd, &mut rect).is_ok() }
                    && (cursor.x < rect.left || cursor.x >= rect.right || cursor.y < rect.top || cursor.y >= rect.bottom);
                if outside {
                    let _ = win.emit("bubble:outside", ());
                }
            }
            if escape && !escape_was_down && unsafe { GetForegroundWindow() } != hwnd {
                let _ = win.emit("bubble:escape", ());
            }
            (mouse_was_down, escape_was_down) = (mouse, escape);
            std::thread::sleep(OUTSIDE_POLL);
        }
        WATCHING.store(false, Ordering::SeqCst);
    });
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
    // Le micro s'ouvre dès l'appui : sinon les premiers mots, dits pendant le délai, seraient perdus.
    let _ = app.emit("ptt:prime", ());

    // L'événement « relâché » du raccourci global n'arrive pas toujours (Alt lâché avant Espace…) :
    // on surveille aussi la touche elle-même, ce qui garantit la fin de l'écoute.
    let app = app.clone();
    std::thread::spawn(move || {
        let start = std::time::Instant::now();
        loop {
            std::thread::sleep(KEY_POLL);
            if !system::key_down(SHORTCUT_KEY) {
                on_shortcut_released(&app);
                return;
            }
            let state = app.state::<AppState>();
            let mut hk = state.hotkey.lock().unwrap();
            if !hk.pressed || hk.press_id != id {
                return; // déjà relâché par l'événement du raccourci
            }
            // Vérifié et marqué sous le même verrou : un relâchement arrivé entre les deux
            // laisserait sinon l'écoute démarrer sans que personne ne l'arrête.
            if !hk.ptt && start.elapsed() >= PTT_DELAY {
                hk.ptt = true;
                drop(hk);
                if let Some(win) = main_window(&app) {
                    let _ = win.set_focus();
                }
                let _ = app.emit("ptt:start", ());
            }
        }
    });
}

/// Appelé par l'événement du raccourci et par la surveillance de la touche : seul le premier compte.
fn on_shortcut_released(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut hk = state.hotkey.lock().unwrap();
    if !hk.pressed {
        return;
    }
    hk.pressed = false;
    if hk.ptt {
        hk.ptt = false;
        drop(hk);
        let _ = app.emit("ptt:end", ());
    } else if hk.was_visible {
        // Appui court alors que la bulle était ouverte : on la referme.
        drop(hk);
        let _ = app.emit("bubble:close", ());
    } else {
        // Appui court qui vient d'ouvrir la bulle : le micro ouvert par précaution se referme.
        drop(hk);
        let _ = app.emit("ptt:cancel", ());
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

fn remember_previous_window(win: &WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    let hwnd = unsafe { GetForegroundWindow() };
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    // La bulle ou les paramètres de NozBar ne comptent pas.
    if !hwnd.is_invalid() && pid != std::process::id() {
        *win.state::<AppState>().previous_window.lock().unwrap() = hwnd.0 as isize;
    }
}

fn previous_window(state: &AppState) -> windows::Win32::Foundation::HWND {
    windows::Win32::Foundation::HWND(*state.previous_window.lock().unwrap() as _)
}

/// Alt+Espace est aussi le raccourci Windows du menu système de la fenêtre active. Pendant un appui long,
/// la répétition d'Espace (ou le relâchement d'Alt) atteint la bulle, qui ouvrait ce menu — invisible,
/// la bulle n'ayant pas de barre de titre — et restait figée jusqu'à la touche suivante : l'écoute ne
/// s'arrêtait plus. On ignore donc toute ouverture de menu au clavier sur la bulle.
#[cfg(windows)]
fn block_system_menu(win: &WebviewWindow) {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{SC_KEYMENU, WM_SYSCOMMAND};

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _: usize, _: usize) -> LRESULT {
        if msg == WM_SYSCOMMAND && (wparam.0 & 0xFFF0) as u32 == SC_KEYMENU {
            return LRESULT(0);
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    if let Ok(handle) = win.hwnd() {
        unsafe {
            let _ = SetWindowSubclass(HWND(handle.0 as _), Some(proc), 1, 0);
        }
    }
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
    if let Ok(handle) = window.hwnd() {
        system::bring_to_front(handle.0 as isize);
    }
    let _ = window.set_focus();
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
fn set_api_key(app: AppHandle, provider: String, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        secrets::delete(&provider)?;
    } else {
        secrets::set(&provider, key)?;
    }
    // La bulle recharge la clé, même si elle a été changée depuis la fenêtre de paramètres.
    let _ = app.emit("keys:changed", &provider);
    Ok(())
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
            &settings::allowed_tools(&app.state::<SettingsState>().get().permissions),
        );
        claude_code::run(&app.state::<claude_code::Running>(), &prompt, args, |line| {
            let _ = on_line.send(line);
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn claude_code_login() -> Result<(), String> {
    claude_code::login()
}

#[tauri::command]
async fn claude_code_logout() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(claude_code::logout).await.map_err(|e| e.to_string())?
}

/// Réglages en mémoire, et leur fichier.
pub struct SettingsState {
    path: std::path::PathBuf,
    current: Mutex<settings::Settings>,
}

impl SettingsState {
    fn get(&self) -> settings::Settings {
        self.current.lock().unwrap().clone()
    }
}

#[tauri::command]
fn get_settings(state: tauri::State<SettingsState>) -> settings::Settings {
    state.get()
}

/// Enregistre et prévient toutes les fenêtres (la bulle applique les règles tout de suite).
#[tauri::command]
fn set_settings(app: AppHandle, settings: settings::Settings, state: tauri::State<SettingsState>) -> Result<(), String> {
    settings::save(&state.path, &settings)?;
    *state.current.lock().unwrap() = settings.clone();
    let _ = app.emit("settings:changed", settings);
    Ok(())
}

/// Fenêtre de paramètres : créée à la demande, réaffichée si elle existe déjà.
#[tauri::command]
fn open_preferences(app: AppHandle) -> Result<(), String> {
    show_preferences(&app)
}

fn show_preferences(app: &AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.unminimize();
        return win.set_focus().map_err(|e| e.to_string());
    }
    tauri::WebviewWindowBuilder::new(app, "settings", tauri::WebviewUrl::App("index.html#settings".into()))
        .title("Paramètres de NozBar")
        .inner_size(560.0, 720.0)
        .min_inner_size(460.0, 480.0)
        .center()
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
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

/// Peut attendre quelques secondes que l'application se termine : hors du thread principal.
#[tauri::command]
async fn close_app(target: String) -> Result<running_apps::Closed, String> {
    tauri::async_runtime::spawn_blocking(move || running_apps::close(&target)).await.map_err(|e| e.to_string())?
}

/// Noms d'applications (ouvertes d'abord, puis installées) que la transcription vocale doit savoir écrire.
#[tauri::command]
async fn speech_hints(app: AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let installed = app.state::<AppIndex>().entries().into_iter().map(|a| a.name);
        let mut seen = std::collections::HashSet::new();
        running_apps::open_names()
            .into_iter()
            .chain(installed)
            .map(|n| n.trim().to_string())
            .filter(|n| (2..=40).contains(&n.chars().count()) && seen.insert(n.to_lowercase()))
            .take(SPEECH_HINTS_MAX)
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
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
fn get_autostart() -> bool {
    autostart::is_enabled()
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    autostart::set_enabled(enabled)
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

// ---------- Navigateur, fenêtres, écran ----------

/// UI Automation et les attentes de fermeture sont bloquantes : toujours hors du fil principal.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn resolve_tab(query: String) -> Result<resolver::Resolution, String> {
    blocking(move || browser::resolve(&query)).await
}

#[tauri::command]
async fn list_tabs() -> Result<Vec<resolver::Candidate>, String> {
    blocking(browser::candidates).await
}

#[tauri::command]
async fn switch_tab(target: String) -> Result<(), String> {
    blocking(move || browser::switch_to(&target)).await?
}

#[tauri::command]
async fn close_tab(target: String) -> Result<(), String> {
    blocking(move || browser::close(&target)).await?
}

#[tauri::command]
async fn read_page(app: AppHandle) -> Result<browser::Page, String> {
    let looking_at = previous_window(&app.state::<AppState>()).0 as isize;
    blocking(move || browser::read_page(windows::Win32::Foundation::HWND(looking_at as _))).await?
}

#[tauri::command]
async fn default_browser() -> Result<Option<String>, String> {
    blocking(browser::default_browser).await
}

#[tauri::command]
async fn window_action(target: String, action: String) -> Result<(), String> {
    blocking(move || window_control::act(&target, &action)).await?
}

#[tauri::command]
fn show_desktop() -> Result<(), String> {
    window_control::show_desktop()
}

#[tauri::command]
async fn get_selection(app: AppHandle) -> Result<String, String> {
    let window = previous_window(&app.state::<AppState>()).0 as isize;
    blocking(move || screen::selection(windows::Win32::Foundation::HWND(window as _))).await?
}

#[tauri::command]
fn read_clipboard() -> Result<String, String> {
    screen::read_clipboard()
}

#[tauri::command]
fn write_clipboard(text: String) -> Result<(), String> {
    screen::write_clipboard(&text)
}

#[tauri::command]
async fn capture_screen(app: AppHandle) -> Result<String, String> {
    let around = previous_window(&app.state::<AppState>()).0 as isize;
    let bubble = main_window(&app).and_then(|w| w.hwnd().ok()).map_or(0, |h| h.0 as isize);
    blocking(move || {
        use windows::Win32::Foundation::HWND;
        screen::capture(HWND(around as _), HWND(bubble as _))
    })
    .await?
}

// ---------- Périphériques et système ----------

#[tauri::command]
async fn audio_outputs() -> Result<Vec<devices::AudioOutput>, String> {
    blocking(devices::outputs).await?
}

#[tauri::command]
async fn resolve_audio_output(query: String) -> Result<resolver::Resolution, String> {
    blocking(move || devices::resolve_output(&query)).await?
}

#[tauri::command]
async fn set_audio_output(id: String) -> Result<(), String> {
    blocking(move || devices::set_output(&id)).await?
}

#[tauri::command]
async fn set_microphone(muted: Option<bool>) -> Result<bool, String> {
    blocking(move || devices::set_microphone_muted(muted)).await?
}

#[tauri::command]
async fn set_brightness(level: Option<i32>, delta: Option<i32>) -> Result<u32, String> {
    blocking(move || devices::set_brightness(level, delta)).await?
}

#[tauri::command]
async fn set_dark_mode(mode: String) -> Result<bool, String> {
    blocking(move || power::set_dark_mode(&mode)).await?
}

#[tauri::command]
fn power_action(action: String) -> Result<(), String> {
    power::power(&action)
}

#[tauri::command]
async fn system_status() -> Result<power::Status, String> {
    blocking(power::status).await?
}

#[tauri::command]
async fn now_playing() -> Result<Option<system::NowPlaying>, String> {
    blocking(system::now_playing).await?
}

#[tauri::command]
async fn resolve_game(query: String) -> Result<resolver::Resolution, String> {
    blocking(move || steam::resolve(&query)).await
}

#[tauri::command]
async fn launch_game(app_id: String) -> Result<(), String> {
    blocking(move || steam::launch(&app_id)).await?
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
            if let (tauri::WindowEvent::Focused(false), "main") = (event, window.label()) {
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

            let settings_path = app.path().app_config_dir()?.join("settings.json");
            let current = Mutex::new(settings::load(&settings_path));
            app.manage(SettingsState { path: settings_path, current });

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
                #[cfg(windows)]
                block_system_menu(&win);
            }

            let open = MenuItem::with_id(app, "open", "Ouvrir NozBar", true, None::<&str>)?;
            let prefs = MenuItem::with_id(app, "settings", "Paramètres", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &prefs, &quit])?;
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
                    "settings" => {
                        let _ = show_preferences(app);
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
            speech_hints,
            find_files,
            check_file,
            open_file,
            get_location,
            mcp_set_tools,
            mcp_reply,
            claude_code_status,
            claude_code_send,
            claude_code_cancel,
            claude_code_login,
            claude_code_logout,
            get_settings,
            set_settings,
            open_preferences,
            open_url,
            open_settings,
            media_control,
            set_volume,
            set_timer,
            get_autostart,
            set_autostart,
            resolve_tab,
            list_tabs,
            switch_tab,
            close_tab,
            read_page,
            default_browser,
            window_action,
            show_desktop,
            get_selection,
            read_clipboard,
            write_clipboard,
            capture_screen,
            audio_outputs,
            resolve_audio_output,
            set_audio_output,
            set_microphone,
            set_brightness,
            set_dark_mode,
            power_action,
            system_status,
            now_playing,
            resolve_game,
            launch_game,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au démarrage de NozBar");
}
