//! Lecture et écriture de quelques valeurs du Registre (thème, navigateur par défaut, Steam, démarrage).

use windows::core::HSTRING;
use windows::Win32::System::Registry::{
    RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY, REG_DWORD, REG_SZ, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};

pub use windows::Win32::System::Registry::HKEY_CURRENT_USER;

pub fn read_string(root: HKEY, path: &str, name: &str) -> Option<String> {
    let (path, name) = (HSTRING::from(path), HSTRING::from(name));
    let mut size = 0u32;
    unsafe {
        RegGetValueW(root, &path, &name, RRF_RT_REG_SZ, None, None, Some(&mut size)).ok().ok()?;
        let mut buf = vec![0u16; size as usize / 2 + 1];
        RegGetValueW(root, &path, &name, RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut size))
            .ok()
            .ok()?;
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    }
}

pub fn read_dword(root: HKEY, path: &str, name: &str) -> Option<u32> {
    let mut value = 0u32;
    let mut size = 4u32;
    unsafe {
        RegGetValueW(
            root,
            &HSTRING::from(path),
            &HSTRING::from(name),
            RRF_RT_REG_DWORD,
            None,
            Some((&mut value as *mut u32).cast()),
            Some(&mut size),
        )
        .ok()
        .ok()?;
    }
    Some(value)
}

pub fn write_string(root: HKEY, path: &str, name: &str, value: &str) -> Result<(), String> {
    let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        RegSetKeyValueW(
            root,
            &HSTRING::from(path),
            &HSTRING::from(name),
            REG_SZ.0,
            Some(wide.as_ptr().cast()),
            (wide.len() * 2) as u32,
        )
        .ok()
        .map_err(|e| format!("Registre inaccessible : {e}"))
    }
}

/// Supprime la valeur ; absente, ce n'est pas une erreur.
pub fn delete_value(root: HKEY, path: &str, name: &str) -> Result<(), String> {
    use windows::Win32::Foundation::ERROR_FILE_NOT_FOUND;
    let result = unsafe { RegDeleteKeyValueW(root, &HSTRING::from(path), &HSTRING::from(name)) };
    if result.is_ok() || result == ERROR_FILE_NOT_FOUND {
        Ok(())
    } else {
        Err(format!("Registre inaccessible : {}", result.to_hresult().message()))
    }
}

pub fn write_dword(root: HKEY, path: &str, name: &str, value: u32) -> Result<(), String> {
    unsafe {
        RegSetKeyValueW(
            root,
            &HSTRING::from(path),
            &HSTRING::from(name),
            REG_DWORD.0,
            Some((&value as *const u32).cast()),
            4,
        )
        .ok()
        .map_err(|e| format!("Registre inaccessible : {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_reads_and_deletes_a_string() {
        // Une clé qui existe toujours : le test ne laisse rien derrière lui.
        let path = r"Software\Microsoft\Windows\CurrentVersion\Explorer";
        write_string(HKEY_CURRENT_USER, path, "NozBarEssai", "\"C:\\Program Files\\NozBar\\nozbar.exe\"").unwrap();
        assert_eq!(
            read_string(HKEY_CURRENT_USER, path, "NozBarEssai").as_deref(),
            Some("\"C:\\Program Files\\NozBar\\nozbar.exe\"")
        );
        delete_value(HKEY_CURRENT_USER, path, "NozBarEssai").unwrap();
        assert_eq!(read_string(HKEY_CURRENT_USER, path, "NozBarEssai"), None);
        // Supprimer une valeur absente n'est pas une erreur.
        delete_value(HKEY_CURRENT_USER, path, "NozBarEssai").unwrap();
    }
}
