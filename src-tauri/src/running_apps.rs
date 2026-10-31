//! Applications ouvertes (fenêtres visibles) : retrouver celle que l'utilisateur veut fermer,
//! puis la fermer proprement (comme un clic sur la croix : elle peut proposer d'enregistrer).

use std::collections::BTreeMap;

use crate::resolver::{classify, Candidate, Resolution};

/// Hôte commun des applications du Store : le nom utile est dans le titre de la fenêtre.
const FRAME_HOST: &str = "applicationframehost";
/// Fenêtres du bureau et de la barre des tâches : les « fermer » proposerait d'éteindre le PC.
const SHELL_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

#[derive(Clone, Debug)]
pub struct OpenWindow {
    pub exe: String,
    pub title: String,
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
    title.rsplit(" - ").next().unwrap_or(title).trim()
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
    let mut by_target: BTreeMap<String, (String, Vec<&str>)> = BTreeMap::new();
    for w in windows {
        let label = if is_frame_host(w) { w.title.clone() } else { stem(&w.exe).to_string() };
        let entry = by_target.entry(target_of(w)).or_insert_with(|| (label, Vec::new()));
        entry.1.push(title_suffix(&w.title));
    }
    by_target
        .into_iter()
        .map(|(target, (label, suffixes))| {
            let names = std::iter::once(label.as_str()).chain(suffixes.iter().copied()).collect::<Vec<_>>().join(" ");
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

/// Ferme toutes les fenêtres de l'application désignée ; renvoie leur nombre.
pub fn close(target: &str) -> Result<usize, String> {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};
    let mut closed = 0;
    for (hwnd, w) in open_windows() {
        if matches_target(&w, target) && unsafe { PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) }.is_ok() {
            closed += 1;
        }
    }
    if closed == 0 {
        Err("Cette application n'est plus ouverte".into())
    } else {
        Ok(closed)
    }
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

/// Fenêtres principales visibles, hors NozBar, bureau, barre des tâches et fenêtres masquées.
fn open_windows() -> Vec<(windows::Win32::Foundation::HWND, OpenWindow)> {
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
            out.push((hwnd, OpenWindow { exe, title }));
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
        OpenWindow { exe: format!("C:\\Program Files\\{exe}"), title: title.into() }
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
        ]
    }

    #[test]
    fn one_candidate_per_application() {
        let list = candidates(&sample());
        assert_eq!(list.iter().filter(|c| c.label == "chrome").count(), 1);
        assert_eq!(list.len(), 3);
    }

    #[test]
    fn finds_apps_by_executable_or_window_name() {
        assert_eq!(label(&resolve_in("chrome", &sample())), Some("chrome"));
        assert_eq!(label(&resolve_in("google chrome", &sample())), Some("chrome"));
        assert_eq!(label(&resolve_in("spotify", &sample())), Some("Spotify"));
        // Applications du Store : le processus est un hôte commun, c'est le titre qui compte.
        assert_eq!(label(&resolve_in("la calculatrice", &sample())), Some("Calculatrice"));
        assert!(matches!(resolve_in("photoshop", &sample()), Resolution::Nothing));
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
}
