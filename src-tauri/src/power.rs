//! Le PC lui-même : verrouiller, mettre en veille, éteindre, mode sombre, état (processeur, mémoire, batterie).

use std::collections::HashMap;
use std::os::windows::process::CommandExt;

use serde::Serialize;

use crate::registry::{read_dword, write_dword, HKEY_CURRENT_USER};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const PERSONALIZE: &str = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
const TOP_PROCESSES: usize = 5;

pub fn power(action: &str) -> Result<(), String> {
    match action {
        "lock" => unsafe { windows::Win32::System::Shutdown::LockWorkStation() }.map_err(|e| e.to_string()),
        "sleep" => {
            // Sans le privilège d'arrêt, Windows refuse la mise en veille : `false` = veille, pas hibernation.
            enable_shutdown_privilege();
            if unsafe { windows::Win32::System::Power::SetSuspendState(false, false, false) } {
                Ok(())
            } else {
                Err("Windows a refusé la mise en veille".into())
            }
        }
        "shutdown" => shutdown(&["/s", "/t", "0"]),
        "restart" => shutdown(&["/r", "/t", "0"]),
        other => Err(format!("Action inconnue : {other}")),
    }
}

/// Le privilège existe pour tout utilisateur, mais il est désactivé tant qu'on ne le demande pas.
fn enable_shutdown_privilege() {
    use windows::Win32::Foundation::{CloseHandle, HANDLE, LUID};
    use windows::Win32::Security::{
        AdjustTokenPrivileges, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES, SE_PRIVILEGE_ENABLED, SE_SHUTDOWN_NAME,
        TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &mut token).is_err() {
            return;
        }
        let mut luid = LUID::default();
        if LookupPrivilegeValueW(None, SE_SHUTDOWN_NAME, &mut luid).is_ok() {
            let privileges = TOKEN_PRIVILEGES {
                PrivilegeCount: 1,
                Privileges: [LUID_AND_ATTRIBUTES { Luid: luid, Attributes: SE_PRIVILEGE_ENABLED }],
            };
            let _ = AdjustTokenPrivileges(token, false, Some(&privileges), 0, None, None);
        }
        let _ = CloseHandle(token);
    }
}

fn shutdown(args: &[&str]) -> Result<(), String> {
    let status = std::process::Command::new("shutdown")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Windows a refusé l'arrêt".into())
    }
}

/// `mode` : "dark", "light" ou "toggle". Renvoie vrai si le mode sombre est maintenant actif.
pub fn set_dark_mode(mode: &str) -> Result<bool, String> {
    let light_now = read_dword(HKEY_CURRENT_USER, PERSONALIZE, "AppsUseLightTheme").unwrap_or(1) != 0;
    let dark = match mode {
        "dark" => true,
        "light" => false,
        "toggle" => light_now,
        other => return Err(format!("Mode inconnu : {other}")),
    };
    let value = u32::from(!dark);
    write_dword(HKEY_CURRENT_USER, PERSONALIZE, "AppsUseLightTheme", value)?;
    write_dword(HKEY_CURRENT_USER, PERSONALIZE, "SystemUsesLightTheme", value)?;
    broadcast_theme_change();
    Ok(dark)
}

/// Prévient les applications ouvertes, qui changent de thème sans redémarrer.
fn broadcast_theme_change() {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE};
    let topic = HSTRING::from("ImmersiveColorSet");
    unsafe {
        let _ = SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            WPARAM(0),
            LPARAM(topic.as_ptr() as isize),
            SMTO_ABORTIFHUNG,
            200,
            None,
        );
    }
}

#[derive(Debug, Serialize)]
pub struct ProcessUsage {
    pub name: String,
    /// Part du processeur total, en pourcents.
    pub cpu: f32,
    pub memory_mb: u64,
}

#[derive(Debug, Serialize)]
pub struct Battery {
    pub percent: u8,
    pub charging: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub cpu: f32,
    pub memory_used_gb: f64,
    pub memory_total_gb: f64,
    pub by_cpu: Vec<ProcessUsage>,
    pub by_memory: Vec<ProcessUsage>,
    pub battery: Option<Battery>,
}

/// Mesure sur une demi-seconde : la charge du processeur se calcule entre deux relevés.
pub fn status() -> Result<Status, String> {
    use sysinfo::{ProcessesToUpdate, System};
    let mut sys = System::new().map_err(|e| e.to_string())?;
    sys.refresh_cpu_usage();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL.max(std::time::Duration::from_millis(500)));
    sys.refresh_cpu_usage();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    sys.refresh_memory();

    let cores = sys.cpus().len().max(1) as f32;
    // Chrome, Brave ou Discord lancent des dizaines de processus : on les additionne par nom.
    let mut usage: HashMap<String, (f32, u64)> = HashMap::new();
    for process in sys.processes().values() {
        let name = process.name().to_string_lossy();
        let name = name.strip_suffix(".exe").unwrap_or(&name).to_string();
        if name == "System Idle Process" || name == "Idle" {
            continue;
        }
        let entry = usage.entry(name).or_default();
        entry.0 += process.cpu_usage() / cores;
        entry.1 += process.memory();
    }
    let mut list: Vec<ProcessUsage> = usage
        .into_iter()
        .map(|(name, (cpu, bytes))| ProcessUsage { name, cpu: (cpu * 10.0).round() / 10.0, memory_mb: bytes / 1_048_576 })
        .collect();
    list.sort_by(|a, b| b.cpu.total_cmp(&a.cpu));
    let by_cpu = list.iter().take(TOP_PROCESSES).map(clone_usage).collect();
    list.sort_by_key(|p| std::cmp::Reverse(p.memory_mb));
    let by_memory = list.iter().take(TOP_PROCESSES).map(clone_usage).collect();

    let gb = |bytes: u64| (bytes as f64 / 1_073_741_824.0 * 10.0).round() / 10.0;
    Ok(Status {
        cpu: sys.global_cpu_usage().round(),
        memory_used_gb: gb(sys.used_memory()),
        memory_total_gb: gb(sys.total_memory()),
        by_cpu,
        by_memory,
        battery: battery(),
    })
}

fn clone_usage(p: &ProcessUsage) -> ProcessUsage {
    ProcessUsage { name: p.name.clone(), cpu: p.cpu, memory_mb: p.memory_mb }
}

fn battery() -> Option<Battery> {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut s = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut s) }.ok()?;
    // 128 : pas de batterie ; 255 : niveau inconnu.
    if s.BatteryFlag & 128 != 0 || s.BatteryLifePercent > 100 {
        return None;
    }
    Some(Battery { percent: s.BatteryLifePercent, charging: s.ACLineStatus == 1 })
}

#[cfg(test)]
mod tests {
    /// Dépend de la machine : `cargo test --lib real_status -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_status() {
        println!("{:#?}", super::status());
    }
}
