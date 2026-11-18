//! Actions système exposées aux outils de l'IA : ouverture, médias, volume.

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VIRTUAL_KEY, VK_CONTROL, VK_LBUTTON, VK_LWIN, VK_MBUTTON, VK_MEDIA_NEXT_TRACK, VK_MEDIA_PLAY_PAUSE,
    VK_MEDIA_PREV_TRACK, VK_MEDIA_STOP, VK_MENU, VK_RBUTTON, VK_RWIN, VK_VOLUME_MUTE,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

/// Équivalent d'un double-clic dans l'Explorateur.
pub fn shell_open(target: &str) -> Result<(), String> {
    let result = unsafe {
        ShellExecuteW(
            None,
            &HSTRING::from("open"),
            &HSTRING::from(target),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecute renvoie une valeur > 32 en cas de succès.
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err(format!("ShellExecute a échoué ({})", result.0 as isize))
    }
}

pub fn open_url(url: &str) -> Result<(), String> {
    let allowed = ["https://", "http://", "mailto:", "spotify:"];
    if !allowed.iter().any(|p| url.to_ascii_lowercase().starts_with(p)) {
        return Err(format!("Schéma d'URL non autorisé : {url}"));
    }
    shell_open(url)
}

pub fn open_settings(page: &str) -> Result<(), String> {
    let uri = match page {
        "home" | "" => "ms-settings:",
        "display" => "ms-settings:display",
        "sound" => "ms-settings:sound",
        "bluetooth" => "ms-settings:bluetooth",
        "network" => "ms-settings:network",
        "wifi" => "ms-settings:network-wifi",
        "notifications" => "ms-settings:notifications",
        "personalization" => "ms-settings:personalization",
        "power" => "ms-settings:powersleep",
        "apps" => "ms-settings:appsfeatures",
        "default-apps" => "ms-settings:defaultapps",
        "privacy" => "ms-settings:privacy",
        "update" => "ms-settings:windowsupdate",
        "mouse" => "ms-settings:mousetouchpad",
        "keyboard" => "ms-settings:typing",
        "language" => "ms-settings:regionlanguage",
        other => return Err(format!("Page de paramètres inconnue : {other}")),
    };
    shell_open(uri)
}

/// État de la souris et des touches de navigation, lu au moment où la bulle perd le focus.
/// (bouton de souris enfoncé, touche Alt / Windows / Ctrl enfoncée)
pub fn input_state() -> (bool, bool) {
    let mouse = [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON].into_iter().any(key_down);
    let keys = [VK_MENU, VK_LWIN, VK_RWIN, VK_CONTROL].into_iter().any(key_down);
    (mouse, keys)
}

/// La touche est-elle physiquement enfoncée en ce moment ?
pub fn key_down(vk: VIRTUAL_KEY) -> bool {
    unsafe { (GetAsyncKeyState(vk.0 as i32) as u16 & 0x8000) != 0 }
}

/// Windows refuse de rendre le premier plan à une fenêtre qui vient de le perdre. En rattachant
/// brièvement notre fil à celui de la fenêtre active, la demande est acceptée — sans simuler de touche
/// (un faux Alt activerait la barre de menus de l'application ouverte).
pub fn bring_to_front(hwnd: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow};
    unsafe {
        let ours = GetCurrentThreadId();
        let theirs = GetWindowThreadProcessId(GetForegroundWindow(), None);
        let attached = theirs != 0 && theirs != ours && AttachThreadInput(ours, theirs, true).as_bool();
        let _ = SetForegroundWindow(HWND(hwnd as _));
        if attached {
            let _ = AttachThreadInput(ours, theirs, false);
        }
    }
}

/// Touches à presser (`false`) ou relâcher (`true`), dans l'ordre.
pub fn send_keys(keys: &[(VIRTUAL_KEY, bool)]) -> Result<(), String> {
    let inputs: Vec<INPUT> = keys
        .iter()
        .map(|&(vk, up)| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        })
        .collect();
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err("SendInput a échoué".into())
    }
}

fn tap_key(vk: VIRTUAL_KEY) -> Result<(), String> {
    send_keys(&[(vk, false), (vk, true)])
}


pub fn media_control(action: &str) -> Result<(), String> {
    let vk = match action {
        "play_pause" | "play" | "pause" => VK_MEDIA_PLAY_PAUSE,
        "next" => VK_MEDIA_NEXT_TRACK,
        "previous" => VK_MEDIA_PREV_TRACK,
        "stop" => VK_MEDIA_STOP,
        "mute" => VK_VOLUME_MUTE,
        other => return Err(format!("Action média inconnue : {other}")),
    };
    tap_key(vk)
}

#[derive(serde::Serialize)]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub app: String,
    pub playing: bool,
}

/// Morceau ou vidéo en cours, tel que l'affiche le panneau multimédia de Windows.
pub fn now_playing() -> Result<Option<NowPlaying>, String> {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
    };
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let manager = Manager::RequestAsync().and_then(|op| op.get()).map_err(|e| e.to_string())?;
    let Ok(session) = manager.GetCurrentSession() else { return Ok(None) };
    let props = session.TryGetMediaPropertiesAsync().and_then(|op| op.get()).map_err(|e| e.to_string())?;
    let playing = session
        .GetPlaybackInfo()
        .and_then(|info| info.PlaybackStatus())
        .is_ok_and(|s| s == PlaybackStatus::Playing);
    let app = session.SourceAppUserModelId().map(|s| s.to_string()).unwrap_or_default();
    Ok(Some(NowPlaying {
        title: props.Title().map(|s| s.to_string()).unwrap_or_default(),
        artist: props.Artist().map(|s| s.to_string()).unwrap_or_default(),
        app: app_label(&app),
        playing,
    }))
}

/// « Spotify.exe » → « Spotify », « Brave.W6ICIV3VR54SHUZ32O74UTISVY » → « Brave ».
fn app_label(app_id: &str) -> String {
    let name = app_id.rsplit(['\\', '!']).next().unwrap_or(app_id);
    match name.rsplit_once('.') {
        Some((stem, tail))
            if tail.eq_ignore_ascii_case("exe")
                || (tail.len() >= 10 && tail.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())) =>
        {
            stem.to_string()
        }
        _ => name.to_string(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn media_apps_get_readable_names() {
        assert_eq!(super::app_label("Spotify.exe"), "Spotify");
        assert_eq!(super::app_label("Brave.W6ICIV3VR54SHUZ32O74UTISVY"), "Brave");
        assert_eq!(super::app_label("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "Microsoft.ZuneMusic");
    }
}

fn endpoint_volume() -> Result<IAudioEndpointVolume, String> {
    unsafe {
        // S_FALSE / RPC_E_CHANGED_MODE si déjà initialisé : sans gravité ici.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| e.to_string())?;
        device.Activate(CLSCTX_ALL, None).map_err(|e| e.to_string())
    }
}

/// Règle le volume principal en absolu (`level`) ou en relatif (`delta`), en pourcents.
/// Renvoie le nouveau niveau.
pub fn set_volume(level: Option<i32>, delta: Option<i32>) -> Result<u32, String> {
    let vol = endpoint_volume()?;
    unsafe {
        let current = (vol.GetMasterVolumeLevelScalar().map_err(|e| e.to_string())? * 100.0).round() as i32;
        let target = match (level, delta) {
            (Some(l), _) => l,
            (None, Some(d)) => current + d,
            (None, None) => return Ok(current as u32),
        }
        .clamp(0, 100);
        vol.SetMasterVolumeLevelScalar(target as f32 / 100.0, std::ptr::null())
            .map_err(|e| e.to_string())?;
        if target > 0 {
            let _ = vol.SetMute(false, std::ptr::null());
        }
        Ok(target as u32)
    }
}
