//! Ce que l'utilisateur a sous les yeux : texte sélectionné, presse-papiers, capture d'écran.

use std::time::{Duration, Instant};

use base64::Engine;
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, GetMonitorInfoW,
    MonitorFromPoint, MonitorFromWindow, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
    DIB_RGB_COLORS, MONITORINFO, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY, SRCCOPY,
};
use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
use windows::Win32::UI::Input::KeyboardAndMouse::{VIRTUAL_KEY, VK_CONTROL};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, IsWindow, SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
};

/// Ctrl+C y interromprait la commande en cours au lieu de copier.
const TERMINAL_CLASSES: &[&str] = &["ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS", "mintty", "VirtualConsoleClass"];
const COPY_TIMEOUT: Duration = Duration::from_millis(800);
/// Le côté le plus long de la capture envoyée à l'IA : lisible, sans image trop lourde.
const MAX_SIDE: u32 = 1600;
const JPEG_QUALITY: u8 = 80;

fn clipboard() -> Result<arboard::Clipboard, String> {
    arboard::Clipboard::new().map_err(|e| format!("Presse-papiers indisponible : {e}"))
}

pub fn read_clipboard() -> Result<String, String> {
    clipboard()?.get_text().map_err(|_| "Le presse-papiers ne contient pas de texte".to_string())
}

pub fn write_clipboard(text: &str) -> Result<(), String> {
    clipboard()?.set_text(text.to_string()).map_err(|e| e.to_string())
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 128];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) } as usize;
    String::from_utf16_lossy(&buf[..n])
}

/// Copie la sélection de la fenêtre que l'utilisateur regardait avant d'ouvrir la bulle,
/// puis remet le presse-papiers comme il était.
pub fn selection(window: HWND) -> Result<String, String> {
    if window.is_invalid() || !unsafe { IsWindow(Some(window)) }.as_bool() {
        return Err("Je ne sais pas quelle fenêtre tu regardais".into());
    }
    if TERMINAL_CLASSES.contains(&class_name(window).as_str()) {
        return Err(
            "Dans un terminal, Ctrl+C interromprait la commande : copie le texte toi-même, puis demande-moi de lire le presse-papiers"
                .into(),
        );
    }
    let mut clip = clipboard()?;
    let saved = clip.get_text().ok();
    let before = unsafe { GetClipboardSequenceNumber() };
    crate::system::bring_to_front(window.0 as isize);
    std::thread::sleep(Duration::from_millis(150));
    let c = VIRTUAL_KEY(b'C' as u16);
    crate::system::send_keys(&[(VK_CONTROL, false), (c, false), (c, true), (VK_CONTROL, true)])?;
    let deadline = Instant::now() + COPY_TIMEOUT;
    while unsafe { GetClipboardSequenceNumber() } == before {
        if Instant::now() >= deadline {
            return Err("Aucun texte n'est sélectionné".into());
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    // L'application peut écrire plusieurs formats à la suite : on la laisse finir.
    std::thread::sleep(Duration::from_millis(40));
    let text = clip.get_text().map_err(|_| "La sélection ne contient pas de texte".to_string());
    if let Some(previous) = saved {
        let _ = clip.set_text(previous);
    }
    text
}

/// Capture l'écran où se trouve `around` (sinon l'écran principal), sans la bulle `hide`.
/// Renvoie un JPEG en base64.
pub fn capture(around: HWND, hide: HWND) -> Result<String, String> {
    let monitor = unsafe {
        if !around.is_invalid() && IsWindow(Some(around)).as_bool() {
            MonitorFromWindow(around, MONITOR_DEFAULTTONEAREST)
        } else {
            MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY)
        }
    };
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    unsafe {
        let _ = GetMonitorInfoW(monitor, &mut info);
    }
    // La bulle est exclue de la capture le temps de la prise (Windows 10 2004 et plus récent).
    let hidden = unsafe { SetWindowDisplayAffinity(hide, WDA_EXCLUDEFROMCAPTURE) }.is_ok();
    if hidden {
        std::thread::sleep(Duration::from_millis(80));
    }
    let shot = grab(info.rcMonitor);
    if hidden {
        let _ = unsafe { SetWindowDisplayAffinity(hide, WDA_NONE) };
    }
    let (width, height, rgb) = shot?;
    encode_jpeg(width, height, rgb)
}

fn grab(r: RECT) -> Result<(u32, u32, Vec<u8>), String> {
    let (w, h) = (r.right - r.left, r.bottom - r.top);
    if w <= 0 || h <= 0 {
        return Err("Écran introuvable".into());
    }
    let mut bgra = vec![0u8; (w * h * 4) as usize];
    unsafe {
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bitmap.into());
        let copied = BitBlt(mem, 0, 0, w, h, Some(screen), r.left, r.top, SRCCOPY | CAPTUREBLT);
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // de haut en bas
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let lines = GetDIBits(mem, bitmap, 0, h as u32, Some(bgra.as_mut_ptr().cast()), &mut bmi, DIB_RGB_COLORS);
        SelectObject(mem, old);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        if copied.is_err() || lines == 0 {
            return Err("Capture d'écran impossible".into());
        }
    }
    let rgb = bgra.as_chunks::<4>().0.iter().flat_map(|p| [p[2], p[1], p[0]]).collect();
    Ok((w as u32, h as u32, rgb))
}

fn encode_jpeg(width: u32, height: u32, rgb: Vec<u8>) -> Result<String, String> {
    use image::{imageops::FilterType, RgbImage};
    let mut img = RgbImage::from_raw(width, height, rgb).ok_or("Capture invalide")?;
    let scale = MAX_SIDE as f64 / width.max(height) as f64;
    if scale < 1.0 {
        let (w, h) = ((width as f64 * scale) as u32, (height as f64 * scale) as u32);
        img = image::imageops::resize(&img, w, h, FilterType::Triangle);
    }
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
        .encode_image(&img)
        .map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_captures_are_scaled_down() {
        let (w, h) = (3200u32, 1800u32);
        let encoded = encode_jpeg(w, h, vec![128; (w * h * 3) as usize]).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).unwrap();
        let img = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg).unwrap();
        assert_eq!((img.width(), img.height()), (1600, 900));
    }
}
