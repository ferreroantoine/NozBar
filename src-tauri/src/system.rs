//! Actions système exposées aux outils de l'IA : ouverture, médias, volume.

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VIRTUAL_KEY, VK_MEDIA_NEXT_TRACK, VK_MEDIA_PLAY_PAUSE, VK_MEDIA_PREV_TRACK, VK_MEDIA_STOP,
    VK_VOLUME_MUTE,
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

fn tap_key(vk: VIRTUAL_KEY) -> Result<(), String> {
    let key = |flags: KEYBD_EVENT_FLAGS| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let inputs = [key(KEYBD_EVENT_FLAGS(0)), key(KEYEVENTF_KEYUP)];
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err("SendInput a échoué".into())
    }
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
