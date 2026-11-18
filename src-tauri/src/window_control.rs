//! Fenêtres : premier plan, réduire, agrandir, ancrer à gauche ou à droite, passer sur l'autre écran.

use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, HDC, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowRect, IsIconic, IsZoomed, SetWindowPos, ShowWindow, SWP_NOACTIVATE, SWP_NOZORDER, SW_MAXIMIZE,
    SW_MINIMIZE, SW_RESTORE,
};

use crate::running_apps;

/// Met la fenêtre au premier plan, en la restaurant si elle était réduite.
pub fn show(hwnd: HWND) {
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
    }
    crate::system::bring_to_front(hwnd.0 as isize);
}

pub fn act(target: &str, action: &str) -> Result<(), String> {
    let wins = running_apps::windows_of(target);
    let first = *wins.first().ok_or("Cette application n'est plus ouverte")?;
    unsafe {
        match action {
            "focus" => show(first),
            "minimize" => {
                for w in &wins {
                    let _ = ShowWindow(*w, SW_MINIMIZE);
                }
            }
            "maximize" => {
                let _ = ShowWindow(first, SW_MAXIMIZE);
                show(first);
            }
            "restore" => {
                let _ = ShowWindow(first, SW_RESTORE);
                show(first);
            }
            "left" | "right" => {
                let area = work_area(MonitorFromWindow(first, MONITOR_DEFAULTTONEAREST));
                let half = (area.right - area.left) / 2;
                let rect = if action == "left" {
                    RECT { right: area.left + half, ..area }
                } else {
                    RECT { left: area.left + half, ..area }
                };
                place(first, rect);
                show(first);
            }
            "next_screen" => next_screen(first)?,
            other => return Err(format!("Action inconnue : {other}")),
        }
    }
    Ok(())
}

/// Équivalent de Win+D : réduit tout et montre le bureau (un second appel restaure).
pub fn show_desktop() -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{VIRTUAL_KEY, VK_LWIN};
    let d = VIRTUAL_KEY(b'D' as u16);
    crate::system::send_keys(&[(VK_LWIN, false), (d, false), (d, true), (VK_LWIN, true)])
}

fn work_area(monitor: HMONITOR) -> RECT {
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    unsafe {
        let _ = GetMonitorInfoW(monitor, &mut info);
    }
    info.rcWork
}

/// Place la fenêtre sur `rect` en compensant les bordures invisibles de Windows 10/11.
fn place(hwnd: HWND, rect: RECT) {
    unsafe {
        let _ = ShowWindow(hwnd, SW_RESTORE);
        let (mut outer, mut frame) = (RECT::default(), RECT::default());
        let _ = GetWindowRect(hwnd, &mut outer);
        let measured = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&mut frame as *mut RECT).cast(),
            std::mem::size_of::<RECT>() as u32,
        )
        .is_ok();
        let (l, t, r, b) = if measured {
            (frame.left - outer.left, frame.top - outer.top, outer.right - frame.right, outer.bottom - frame.bottom)
        } else {
            (0, 0, 0, 0)
        };
        let _ = SetWindowPos(
            hwnd,
            None,
            rect.left - l,
            rect.top - t,
            rect.right - rect.left + l + r,
            rect.bottom - rect.top + t + b,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

fn monitors() -> Vec<HMONITOR> {
    unsafe extern "system" fn collect(monitor: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> windows::core::BOOL {
        (*(data.0 as *mut Vec<HMONITOR>)).push(monitor);
        true.into()
    }
    let mut list: Vec<HMONITOR> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(collect), LPARAM(&mut list as *mut _ as isize));
    }
    // De gauche à droite, pour que « l'autre écran » suive l'ordre physique.
    list.sort_by_key(|&m| work_area(m).left);
    list
}

fn next_screen(hwnd: HWND) -> Result<(), String> {
    let screens = monitors();
    if screens.len() < 2 {
        return Err("Il n'y a qu'un seul écran".into());
    }
    unsafe {
        let current = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let index = screens.iter().position(|&m| m == current).unwrap_or(0);
        let (from, to) = (work_area(current), work_area(screens[(index + 1) % screens.len()]));
        let maximized = IsZoomed(hwnd).as_bool();
        let _ = ShowWindow(hwnd, SW_RESTORE);
        let mut rect = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rect);
        let width = (rect.right - rect.left).min(to.right - to.left);
        let height = (rect.bottom - rect.top).min(to.bottom - to.top);
        // Même position relative sur le nouvel écran, sans déborder.
        let x = (to.left + rect.left - from.left).clamp(to.left, to.right - width);
        let y = (to.top + rect.top - from.top).clamp(to.top, to.bottom - height);
        let _ = SetWindowPos(hwnd, None, x, y, width, height, SWP_NOZORDER | SWP_NOACTIVATE);
        if maximized {
            let _ = ShowWindow(hwnd, SW_MAXIMIZE);
        }
    }
    show(hwnd);
    Ok(())
}
