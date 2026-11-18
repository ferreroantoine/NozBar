//! Périphériques : sortie audio par défaut, micro, luminosité des écrans.

use std::ffi::c_void;

use serde::Serialize;
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, IMMDevice, IMMDeviceEnumerator,
    MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ};

use crate::resolver::{classify, Candidate, Resolution};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Interface non documentée (mais stable depuis Windows 7) qu'utilise le panneau Son pour
/// changer de périphérique par défaut. Seul `SetDefaultEndpoint` sert ; les autres réservent leur place.
mod policy_config {
    #![allow(non_snake_case)]
    use std::ffi::c_void;

    use windows::core::{HRESULT, PCWSTR};
    use windows::Win32::Media::Audio::ERole;

    #[windows::core::interface("f8679f50-850a-41cf-9c72-430f290290c8")]
    pub unsafe trait IPolicyConfig: windows::core::IUnknown {
        fn GetMixFormat(&self, id: PCWSTR, format: *mut *mut c_void) -> HRESULT;
        fn GetDeviceFormat(&self, id: PCWSTR, default: i32, format: *mut *mut c_void) -> HRESULT;
        fn ResetDeviceFormat(&self, id: PCWSTR) -> HRESULT;
        fn SetDeviceFormat(&self, id: PCWSTR, endpoint: *mut c_void, mix: *mut c_void) -> HRESULT;
        fn GetProcessingPeriod(&self, id: PCWSTR, default: i32, period: *mut i64, min: *mut i64) -> HRESULT;
        fn SetProcessingPeriod(&self, id: PCWSTR, period: *mut i64) -> HRESULT;
        fn GetShareMode(&self, id: PCWSTR, mode: *mut c_void) -> HRESULT;
        fn SetShareMode(&self, id: PCWSTR, mode: *mut c_void) -> HRESULT;
        fn GetPropertyValue(&self, id: PCWSTR, key: *const c_void, value: *mut c_void) -> HRESULT;
        fn SetPropertyValue(&self, id: PCWSTR, key: *const c_void, value: *mut c_void) -> HRESULT;
        fn SetDefaultEndpoint(&self, id: PCWSTR, role: ERole) -> HRESULT;
        fn SetEndpointVisibility(&self, id: PCWSTR, visible: i32) -> HRESULT;
    }

    const CLSID_POLICY_CONFIG: windows::core::GUID = windows::core::GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

    /// Fait de `id` le périphérique par défaut, pour tous les usages (musique, jeux, appels).
    pub fn set_default(id: &str) -> Result<(), String> {
        use windows::Win32::Media::Audio::{eCommunications, eConsole, eMultimedia};
        use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
        let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let policy: IPolicyConfig = CoCreateInstance(&CLSID_POLICY_CONFIG, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
            for role in [eConsole, eMultimedia, eCommunications] {
                policy.SetDefaultEndpoint(PCWSTR(wide.as_ptr()), role).ok().map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
pub struct AudioOutput {
    pub name: String,
    pub id: String,
    pub default: bool,
}

fn enumerator() -> Result<IMMDeviceEnumerator, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())
    }
}

fn device_id(device: &IMMDevice) -> Option<String> {
    unsafe {
        let raw = device.GetId().ok()?;
        let id = raw.to_string().ok();
        CoTaskMemFree(Some(raw.0 as *const c_void));
        id
    }
}

fn friendly_name(device: &IMMDevice) -> Option<String> {
    unsafe {
        let store = device.OpenPropertyStore(STGM_READ).ok()?;
        let name = store.GetValue(&PKEY_Device_FriendlyName).ok()?.to_string();
        (!name.is_empty()).then_some(name)
    }
}

/// Sorties audio branchées, avec celle par défaut.
pub fn outputs() -> Result<Vec<AudioOutput>, String> {
    let e = enumerator()?;
    unsafe {
        let default = e.GetDefaultAudioEndpoint(eRender, eConsole).ok().and_then(|d| device_id(&d));
        let list = e.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for i in 0..list.GetCount().unwrap_or(0) {
            let Ok(device) = list.Item(i) else { continue };
            let (Some(id), Some(name)) = (device_id(&device), friendly_name(&device)) else { continue };
            out.push(AudioOutput { default: default.as_deref() == Some(id.as_str()), name, id });
        }
        Ok(out)
    }
}

/// Mots courants absents des noms Windows (« Logitech G733 Gaming Headset ») : « passe sur le casque ».
fn spoken_names(name: &str) -> String {
    let lower = name.to_lowercase();
    let mut names = name.to_string();
    if ["headset", "headphone", "casque", "écouteurs", "buds", "airpods"].iter().any(|w| lower.contains(w)) {
        names.push_str(" casque écouteurs");
    }
    if ["haut-parleurs", "speakers", "speaker"].iter().any(|w| lower.contains(w)) {
        names.push_str(" enceinte enceintes");
    }
    names
}

pub fn resolve_output(query: &str) -> Result<Resolution, String> {
    let list = outputs()?
        .into_iter()
        .map(|o| {
            let detail = if o.default { "actuelle" } else { "sortie audio" };
            Candidate::named(&o.name, &spoken_names(&o.name), "audio", &o.id, detail)
        })
        .collect();
    Ok(classify(query, list, Vec::new()))
}

/// Fait de `id` la sortie par défaut, pour tous les usages (musique, jeux, appels).
pub fn set_output(id: &str) -> Result<(), String> {
    if !outputs()?.iter().any(|o| o.id == id) {
        return Err("Cette sortie audio n'est plus branchée".into());
    }
    policy_config::set_default(id)
}

/// Coupe (`Some(true)`), rétablit (`Some(false)`) ou bascule (`None`) le micro par défaut.
/// Renvoie vrai si le micro est maintenant coupé.
pub fn set_microphone_muted(muted: Option<bool>) -> Result<bool, String> {
    let e = enumerator()?;
    unsafe {
        let device = e.GetDefaultAudioEndpoint(eCapture, eConsole).map_err(|_| "Aucun micro n'est branché".to_string())?;
        let volume: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None).map_err(|e| e.to_string())?;
        let target = match muted {
            Some(m) => m,
            None => !volume.GetMute().map_err(|e| e.to_string())?.as_bool(),
        };
        volume.SetMute(target, std::ptr::null()).map_err(|e| e.to_string())?;
        Ok(target)
    }
}

/// Règle la luminosité en absolu (`level`) ou en relatif (`delta`), en pourcents ; renvoie le nouveau niveau.
/// Écrans externes par DDC/CI, écran d'ordinateur portable par WMI.
pub fn set_brightness(level: Option<i32>, delta: Option<i32>) -> Result<u32, String> {
    if let Some(done) = ddc_brightness(level, delta) {
        return Ok(done);
    }
    wmi_brightness(level, delta)
}

fn target_level(current: i32, level: Option<i32>, delta: Option<i32>) -> i32 {
    match (level, delta) {
        (Some(l), _) => l,
        (None, Some(d)) => current + d,
        (None, None) => current,
    }
    .clamp(0, 100)
}

fn ddc_brightness(level: Option<i32>, delta: Option<i32>) -> Option<u32> {
    use windows::Win32::Devices::Display::{
        DestroyPhysicalMonitors, GetMonitorBrightness, GetNumberOfPhysicalMonitorsFromHMONITOR,
        GetPhysicalMonitorsFromHMONITOR, SetMonitorBrightness, PHYSICAL_MONITOR,
    };
    use windows::Win32::Foundation::{LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR};

    unsafe extern "system" fn collect(monitor: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> windows::core::BOOL {
        (*(data.0 as *mut Vec<HMONITOR>)).push(monitor);
        true.into()
    }
    let mut monitors: Vec<HMONITOR> = Vec::new();
    let mut result = None;
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(collect), LPARAM(&mut monitors as *mut _ as isize));
        for monitor in monitors {
            let mut count = 0u32;
            if GetNumberOfPhysicalMonitorsFromHMONITOR(monitor, &mut count).is_err() || count == 0 {
                continue;
            }
            let mut physical = vec![PHYSICAL_MONITOR::default(); count as usize];
            if GetPhysicalMonitorsFromHMONITOR(monitor, &mut physical).is_err() {
                continue;
            }
            for p in &physical {
                let (mut min, mut current, mut max) = (0u32, 0u32, 0u32);
                if GetMonitorBrightness(p.hPhysicalMonitor, &mut min, &mut current, &mut max) == 0 || max <= min {
                    continue;
                }
                let percent = ((current - min) * 100 / (max - min)) as i32;
                let target = target_level(percent, level, delta);
                let raw = min + (max - min) * target as u32 / 100;
                if SetMonitorBrightness(p.hPhysicalMonitor, raw) != 0 {
                    result = Some(target as u32);
                }
            }
            let _ = DestroyPhysicalMonitors(&physical);
        }
    }
    result
}

fn wmi_brightness(level: Option<i32>, delta: Option<i32>) -> Result<u32, String> {
    use std::os::windows::process::CommandExt;
    let target = match (level, delta) {
        (Some(l), _) => l.clamp(0, 100).to_string(),
        (None, Some(d)) => format!("[Math]::Max(0, [Math]::Min(100, $current + ({d})))"),
        (None, None) => "$current".into(),
    };
    let script = format!(
        "$ErrorActionPreference='Stop'; \
         $current = (Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness | Select-Object -First 1).CurrentBrightness; \
         $target = {target}; \
         Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | \
         Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{{Timeout=1; Brightness=[byte]$target}} | Out-Null; \
         $target"
    );
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .map_err(|_| "Cet écran ne permet pas de régler la luminosité depuis Windows (réglage DDC/CI désactivé ?)".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brightness_targets_stay_in_range() {
        assert_eq!(target_level(50, Some(80), None), 80);
        assert_eq!(target_level(95, None, Some(10)), 100);
        assert_eq!(target_level(5, None, Some(-10)), 0);
        assert_eq!(target_level(40, None, None), 40);
    }

    /// Dépend de la machine : `cargo test --lib real_audio_outputs -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_audio_outputs() {
        for o in outputs().unwrap() {
            println!("{}{}", o.name, if o.default { " (par défaut)" } else { "" });
        }
    }
}
