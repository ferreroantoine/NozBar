//! Applications ouvertes (fenêtres visibles) : retrouver celle que l'utilisateur veut fermer,
//! puis la fermer proprement (comme un clic sur la croix : elle peut proposer d'enregistrer).
//! Une application qui se replie dans la zone de notification (Steam, Discord…) est ensuite arrêtée.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::resolver::{classify, Candidate, Resolution};

/// Hôte commun des applications du Store : le nom utile est dans le titre de la fenêtre.
const FRAME_HOST: &str = "applicationframehost";
/// Fenêtres du bureau et de la barre des tâches : les « fermer » proposerait d'éteindre le PC.
const SHELL_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];
/// Temps laissé à l'application pour se terminer d'elle-même après la fermeture de ses fenêtres.
const EXIT_WAIT: Duration = Duration::from_secs(4);
const EXIT_POLL: Duration = Duration::from_millis(150);
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Debug)]
pub struct OpenWindow {
    pub exe: String,
    pub title: String,
    pub pid: u32,
}

fn stem(exe: &str) -> &str {
    let name = exe.rsplit(['\\', '/']).next().unwrap_or(exe);
    crate::files::split_ext(name).0
}

fn is_frame_host(w: &OpenWindow) -> bool {
    stem(&w.exe).eq_ignore_ascii_case(FRAME_HOST)
}

/// « Gmail - Google Chrome » → « Google Chrome » : la fin du titre nomme souvent l'application.
fn title_suffix(title: &str) -> &str {
    // Tiret simple (Chrome) ou demi-cadratin (Brave, Edge).
    let cut = [" - ", " – "].iter().filter_map(|sep| title.rfind(sep).map(|i| i + sep.len())).max().unwrap_or(0);
    title[cut..].trim()
}

/// Nom sous lequel on désigne la fenêtre. Pour un navigateur, seulement le sien : le titre
/// de la page (« YouTube – Brave ») ferait fermer tout le navigateur pour « ferme YouTube ».
fn spoken_name(w: &OpenWindow) -> String {
    let suffix = title_suffix(&w.title);
    match crate::browser::browser_name(&w.exe) {
        // « Gmail - Google Chrome » : la fin du titre nomme bien le navigateur, on la garde.
        Some(browser) if !suffix.contains(browser) => browser.to_string(),
        _ => suffix.to_string(),
    }
}

fn target_of(w: &OpenWindow) -> String {
    if is_frame_host(w) {
        format!("title:{}", w.title)
    } else {
        format!("exe:{}", w.exe.to_lowercase())
    }
}

pub fn matches_target(w: &OpenWindow, target: &str) -> bool {
    target_of(w) == target
}

/// Une proposition par application, quel que soit son nombre de fenêtres.
pub fn candidates(windows: &[OpenWindow]) -> Vec<Candidate> {
    let mut by_target: BTreeMap<String, (String, Vec<String>)> = BTreeMap::new();
    for w in windows {
        let label = if is_frame_host(w) { w.title.clone() } else { stem(&w.exe).to_string() };
        let entry = by_target.entry(target_of(w)).or_insert_with(|| (label, Vec::new()));
        entry.1.push(spoken_name(w));
    }
    by_target
        .into_iter()
        .map(|(target, (label, suffixes))| {
            let names =
                std::iter::once(label.as_str()).chain(suffixes.iter().map(String::as_str)).collect::<Vec<_>>().join(" ");
            let count = suffixes.len();
            let detail = if count > 1 { format!("{count} fenêtres") } else { "ouverte".into() };
            Candidate::named(&label, &names, "app", &target, &detail)
        })
        .collect()
}

pub fn resolve_in(query: &str, windows: &[OpenWindow]) -> Resolution {
    classify(query, candidates(windows), Vec::new())
}

pub fn resolve(query: &str) -> Resolution {
    resolve_in(query, &open_windows().into_iter().map(|(_, w)| w).collect::<Vec<_>>())
}

/// Noms des applications ouvertes (exécutable et fin du titre), pour guider la transcription vocale.
pub fn open_names() -> Vec<String> {
    let mut names = Vec::new();
    for (_, w) in open_windows() {
        names.push(if is_frame_host(&w) { w.title.clone() } else { stem(&w.exe).to_string() });
        // Pas de titre de page web : il partirait chez Gemini avec chaque message vocal.
        names.push(spoken_name(&w));
    }
    names
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Closed {
    pub windows: usize,
    /// L'application restait en arrière-plan après ses fenêtres : elle a été arrêtée.
    pub background: bool,
}

/// Ferme toutes les fenêtres de l'application désignée, puis l'arrête si elle reste en arrière-plan.
pub fn close(target: &str) -> Result<Closed, String> {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};
    let mut closed = 0;
    let mut pids = BTreeSet::new();
    for (hwnd, w) in open_windows() {
        if matches_target(&w, target) && unsafe { PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) }.is_ok() {
            closed += 1;
            pids.insert(w.pid);
        }
    }
    if closed == 0 {
        return Err("Cette application n'est plus ouverte".into());
    }
    // Applications du Store : l'hôte commun en porte d'autres, on ne l'arrête jamais.
    let background = !target.starts_with("title:") && stop_background(&pids);
    Ok(Closed { windows: closed, background })
}

/// Attend que l'application se termine ; si elle tourne encore sans fenêtre visible, l'arrête
/// avec tous ses processus. Renvoie vrai si un arrêt forcé a eu lieu.
fn stop_background(window_pids: &BTreeSet<u32>) -> bool {
    let parents = process_parents();
    let roots: BTreeSet<u32> = window_pids
        .iter()
        .map(|&pid| app_root(pid, &parents, process_path))
        .filter(|&pid| process_path(pid).is_some_and(|p| !is_system_path(&p)))
        .collect();
    let deadline = Instant::now() + EXIT_WAIT;
    loop {
        let alive: Vec<u32> = roots.iter().copied().filter(|&pid| is_alive(pid)).collect();
        if alive.is_empty() {
            return false;
        }
        if Instant::now() >= deadline {
            let parents = process_parents();
            let visible: Vec<u32> = open_windows().into_iter().map(|(_, w)| w.pid).collect();
            let mut stopped = false;
            for root in alive {
                // Une fenêtre encore là (« Enregistrer les modifications ? ») : c'est à l'utilisateur de répondre.
                if visible.iter().any(|&pid| descends_from(pid, root, &parents)) {
                    continue;
                }
                stopped |= kill_tree(root);
            }
            return stopped;
        }
        std::thread::sleep(EXIT_POLL);
    }
}

fn dir_of(path: &str) -> String {
    path.rsplit_once(['\\', '/']).map_or("", |(dir, _)| dir).to_lowercase()
}

/// `child` est `parent` ou l'un de ses sous-dossiers (chemins en minuscules).
fn within(child: &str, parent: &str) -> bool {
    !parent.is_empty() && (child == parent || child.strip_prefix(parent).is_some_and(|rest| rest.starts_with('\\')))
}

fn is_system_path(path: &str) -> bool {
    let windir = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()).to_lowercase();
    within(&dir_of(path), &windir)
}

/// Remonte aux processus parents tant qu'ils viennent du même dossier d'installation :
/// la fenêtre de Steam appartient à steamwebhelper.exe, lancé par steam.exe, qu'il faut arrêter aussi.
fn app_root(pid: u32, parents: &HashMap<u32, u32>, path_of: impl Fn(u32) -> Option<String>) -> u32 {
    let Some(mut dir) = path_of(pid).map(|p| dir_of(&p)) else { return pid };
    let mut current = pid;
    for _ in 0..8 {
        let Some(&parent) = parents.get(&current) else { break };
        if parent == 0 || parent == current || parent == std::process::id() {
            break;
        }
        let Some(path) = path_of(parent) else { break };
        let parent_dir = dir_of(&path);
        if is_system_path(&path) || !within(&dir, &parent_dir) {
            break;
        }
        current = parent;
        dir = parent_dir;
    }
    current
}

fn descends_from(pid: u32, root: u32, parents: &HashMap<u32, u32>) -> bool {
    let mut current = pid;
    for _ in 0..16 {
        if current == root {
            return true;
        }
        match parents.get(&current) {
            Some(&parent) if parent != 0 && parent != current => current = parent,
            _ => return false,
        }
    }
    false
}

/// Processus → processus parent, pour tout le système.
fn process_parents() -> HashMap<u32, u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let mut out = HashMap::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut ok = Process32FirstW(snapshot, &mut entry).is_ok();
        while ok {
            out.insert(entry.th32ProcessID, entry.th32ParentProcessID);
            ok = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    out
}

fn is_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
        let mut code = 0u32;
        let alive = GetExitCodeProcess(handle, &mut code).is_ok() && code == STILL_ACTIVE.0 as u32;
        let _ = CloseHandle(handle);
        alive
    }
}

/// Arrête le processus et tous ceux qu'il a lancés.
fn kill_tree(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .is_ok_and(|o| o.status.success())
}

fn process_path(pid: u32) -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(handle);
        ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// Fenêtres de l'application désignée, de la plus en avant à la plus en arrière.
pub fn windows_of(target: &str) -> Vec<windows::Win32::Foundation::HWND> {
    open_windows().into_iter().filter(|(_, w)| matches_target(w, target)).map(|(hwnd, _)| hwnd).collect()
}

/// Fenêtres principales visibles (de la plus en avant à la plus en arrière), hors NozBar, bureau,
/// barre des tâches et fenêtres masquées.
pub fn open_windows() -> Vec<(windows::Win32::Foundation::HWND, OpenWindow)> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindow, GetWindowLongPtrW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible, GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW,
    };

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam.0 as *mut Vec<(HWND, OpenWindow)>);
        let visible = IsWindowVisible(hwnd).as_bool();
        let owned = GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.is_invalid());
        let tool = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW.0 as isize != 0;
        let mut cloaked = 0u32;
        let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, 4);
        if !visible || owned || tool || cloaked != 0 {
            return true.into();
        }
        let mut class = [0u16; 64];
        let n = GetClassNameW(hwnd, &mut class) as usize;
        if SHELL_CLASSES.contains(&String::from_utf16_lossy(&class[..n]).as_str()) {
            return true.into();
        }
        let mut title = [0u16; 512];
        let n = GetWindowTextW(hwnd, &mut title) as usize;
        let title = String::from_utf16_lossy(&title[..n]);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if title.trim().is_empty() || pid == std::process::id() {
            return true.into();
        }
        if let Some(exe) = process_path(pid) {
            out.push((hwnd, OpenWindow { exe, title, pid }));
        }
        true.into()
    }

    let mut out: Vec<(HWND, OpenWindow)> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut out as *mut _ as isize));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resolver::Resolution;

    fn win(exe: &str, title: &str) -> OpenWindow {
        OpenWindow { exe: format!("C:\\Program Files\\{exe}"), title: title.into(), pid: 0 }
    }

    fn label(r: &Resolution) -> Option<&str> {
        match r {
            Resolution::Open(c) => Some(c.label.as_str()),
            _ => None,
        }
    }

    fn sample() -> Vec<OpenWindow> {
        vec![
            win("Google\\Chrome\\chrome.exe", "Gmail - Google Chrome"),
            win("Google\\Chrome\\chrome.exe", "YouTube - Google Chrome"),
            win("Spotify\\Spotify.exe", "Spotify Premium"),
            win("WindowsApps\\ApplicationFrameHost.exe", "Calculatrice"),
            win("BraveSoftware\\Brave-Browser\\Application\\brave.exe", "Meta VR Glasses - YouTube – Brave"),
        ]
    }

    #[test]
    fn one_candidate_per_application() {
        let list = candidates(&sample());
        assert_eq!(list.iter().filter(|c| c.label == "chrome").count(), 1);
        assert_eq!(list.len(), 4);
    }

    #[test]
    fn finds_apps_by_executable_or_window_name() {
        assert_eq!(label(&resolve_in("chrome", &sample())), Some("chrome"));
        assert_eq!(label(&resolve_in("google chrome", &sample())), Some("chrome"));
        assert_eq!(label(&resolve_in("spotify", &sample())), Some("Spotify"));
        // Applications du Store : le processus est un hôte commun, c'est le titre qui compte.
        assert_eq!(label(&resolve_in("la calculatrice", &sample())), Some("Calculatrice"));
        assert!(matches!(resolve_in("photoshop", &sample()), Resolution::Nothing));
        // Une page ouverte dans un navigateur n'est pas une application : c'est un onglet à fermer.
        assert!(matches!(resolve_in("youtube", &sample()), Resolution::Nothing));
        assert_eq!(label(&resolve_in("brave", &sample())), Some("brave"));
    }

    /// Dépend de la machine : `cargo test --lib real_open_windows -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_open_windows() {
        let wins: Vec<OpenWindow> = open_windows().into_iter().map(|(_, w)| w).collect();
        for c in candidates(&wins) {
            println!("{} ({})", c.label, c.detail);
        }
    }

    #[test]
    fn targets_name_every_window_of_the_application() {
        let list = candidates(&sample());
        let chrome = list.iter().find(|c| c.label == "chrome").unwrap();
        let wins = sample();
        assert_eq!(wins.iter().filter(|w| matches_target(w, &chrome.target)).count(), 2);
        let calc = list.iter().find(|c| c.label == "Calculatrice").unwrap();
        assert_eq!(wins.iter().filter(|w| matches_target(w, &calc.target)).count(), 1);
    }

    #[test]
    fn root_is_the_launcher_from_the_same_install_folder() {
        // explorer (1) → steam (2) → steamwebhelper (3), qui porte la fenêtre.
        let parents = HashMap::from([(3, 2), (2, 1), (1, 0)]);
        let path = |pid| match pid {
            1 => Some("C:\\Windows\\explorer.exe".to_string()),
            2 => Some("C:\\Program Files (x86)\\Steam\\steam.exe".to_string()),
            3 => Some("C:\\Program Files (x86)\\Steam\\bin\\cef\\cef.win7x64\\steamwebhelper.exe".to_string()),
            _ => None,
        };
        assert_eq!(app_root(3, &parents, path), 2);
        assert_eq!(app_root(2, &parents, path), 2);
        // Un dossier voisin au nom proche n'est pas le même logiciel.
        assert!(!within("c:\\program files (x86)\\steamapps", "c:\\program files (x86)\\steam"));
        assert!(descends_from(3, 2, &parents));
        assert!(!descends_from(2, 3, &parents));
    }
}
