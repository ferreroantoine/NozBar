//! Onglets des navigateurs (Brave, Chrome, Edge, Firefox…) par UI Automation : les lister, y aller,
//! les fermer, lire la page affichée — sans capture d'écran ni extension.

use serde::Serialize;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationCondition, IUIAutomationElement, IUIAutomationInvokePattern,
    IUIAutomationSelectionItemPattern, IUIAutomationTextPattern, IUIAutomationValuePattern, TreeScope_Descendants,
    UIA_ButtonControlTypeId, UIA_ControlTypePropertyId, UIA_DocumentControlTypeId, UIA_EditControlTypeId,
    UIA_InvokePatternId, UIA_SelectionItemPatternId, UIA_TabControlTypeId, UIA_TabItemControlTypeId,
    UIA_TextPatternId, UIA_ValuePatternId, UIA_CONTROLTYPE_ID,
};

use crate::registry::{read_string, HKEY_CURRENT_USER};
use crate::resolver::{classify, Candidate, Resolution};
use crate::running_apps;

/// Exécutable → nom affiché.
const BROWSERS: &[(&str, &str)] = &[
    ("brave", "Brave"),
    ("chrome", "Chrome"),
    ("msedge", "Edge"),
    ("firefox", "Firefox"),
    ("opera", "Opera"),
    ("vivaldi", "Vivaldi"),
];
/// Mentions que Chromium ajoute au nom accessible d'un onglet (infobulle de survol).
const TAB_NAME_NOISE: &[&str] = &[
    " - Utilisation de la mémoire",
    " - Memory usage",
    " - Lecture audio",
    " - Audio playing",
    " - Son coupé",
    " - Audio muted",
];
/// Assez pour résumer un article, sans noyer l'IA.
const MAX_PAGE_CHARS: i32 = 15_000;
/// Chromium n'active son arbre d'accessibilité qu'à la première demande : on laisse le temps de le construire.
const ACCESSIBILITY_WARMUP: std::time::Duration = std::time::Duration::from_millis(500);

#[derive(Debug, Serialize)]
pub struct Page {
    pub browser: String,
    pub title: String,
    pub url: String,
    pub text: String,
}

fn automation() -> Result<IUIAutomation, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())
    }
}

pub fn browser_name(exe: &str) -> Option<&'static str> {
    let file = exe.rsplit(['\\', '/']).next().unwrap_or(exe).to_lowercase();
    let stem = file.strip_suffix(".exe").unwrap_or(&file);
    BROWSERS.iter().find(|(s, _)| *s == stem).map(|(_, name)| *name)
}

/// Fenêtres de navigateur, de la plus en avant à la plus en arrière.
fn browser_windows() -> Vec<(HWND, &'static str)> {
    running_apps::open_windows()
        .into_iter()
        .filter_map(|(hwnd, w)| browser_name(&w.exe).map(|name| (hwnd, name)))
        .collect()
}

fn of_type(a: &IUIAutomation, id: UIA_CONTROLTYPE_ID) -> Result<IUIAutomationCondition, String> {
    unsafe { a.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(id.0)).map_err(|e| e.to_string()) }
}

fn name_of(el: &IUIAutomationElement) -> String {
    unsafe { el.CurrentName() }.map(|s| s.to_string()).unwrap_or_default()
}

/// « YouTube - Utilisation de la mémoire - 415Mo » → « YouTube ».
fn clean_title(name: &str) -> &str {
    let cut = TAB_NAME_NOISE.iter().filter_map(|noise| name.find(noise)).min().unwrap_or(name.len());
    name[..cut].trim()
}

fn first(a: &IUIAutomation, root: &IUIAutomationElement, id: UIA_CONTROLTYPE_ID) -> Option<IUIAutomationElement> {
    unsafe { root.FindFirst(TreeScope_Descendants, &of_type(a, id).ok()?).ok() }
}

fn all(a: &IUIAutomation, root: &IUIAutomationElement, id: UIA_CONTROLTYPE_ID) -> Vec<IUIAutomationElement> {
    let Ok(cond) = of_type(a, id) else { return Vec::new() };
    let Ok(items) = (unsafe { root.FindAll(TreeScope_Descendants, &cond) }) else { return Vec::new() };
    let n = unsafe { items.Length() }.unwrap_or(0);
    (0..n).filter_map(|i| unsafe { items.GetElement(i) }.ok()).collect()
}

/// Onglets d'une fenêtre, dans l'ordre de la barre d'onglets.
fn tab_items(a: &IUIAutomation, hwnd: HWND) -> Vec<IUIAutomationElement> {
    let Ok(root) = (unsafe { a.ElementFromHandle(hwnd) }) else { return Vec::new() };
    // La barre d'onglets précède la page dans l'arbre : on cherche dedans plutôt que dans toute la page.
    match first(a, &root, UIA_TabControlTypeId) {
        Some(strip) => all(a, &strip, UIA_TabItemControlTypeId),
        None => all(a, &root, UIA_TabItemControlTypeId),
    }
}

fn is_selected(el: &IUIAutomationElement) -> bool {
    unsafe {
        el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
            .and_then(|p| p.CurrentIsSelected())
            .is_ok_and(|b| b.as_bool())
    }
}

fn select(el: &IUIAutomationElement) -> Result<(), String> {
    unsafe {
        el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
            .and_then(|p| p.Select())
            .map_err(|_| "Impossible d'afficher cet onglet".to_string())
    }
}

/// Identifiant d'onglet : fenêtre, position et titre (vérifié au moment d'agir).
fn tab_target(hwnd: HWND, index: usize, title: &str) -> String {
    format!("{}:{index}:{title}", hwnd.0 as isize)
}

/// Une proposition par onglet ouvert, tous navigateurs confondus.
pub fn candidates() -> Vec<Candidate> {
    let Ok(a) = automation() else { return Vec::new() };
    let mut out = Vec::new();
    for (hwnd, browser) in browser_windows() {
        for (i, el) in tab_items(&a, hwnd).iter().enumerate() {
            let name = name_of(el);
            let title = clean_title(&name);
            if title.is_empty() {
                continue;
            }
            let detail = if is_selected(el) { format!("{browser}, affiché") } else { browser.to_string() };
            out.push(Candidate::named(title, title, "tab", &tab_target(hwnd, i, title), &detail));
        }
    }
    out
}

pub fn resolve(query: &str) -> Resolution {
    resolve_in(query, candidates())
}

/// Contrairement aux applications, un titre exact ne l'emporte pas : avec deux onglets YouTube,
/// « ferme YouTube » fermerait celui qui s'appelle juste « YouTube », pas forcément le bon. On demande.
fn resolve_in(query: &str, tabs: Vec<Candidate>) -> Resolution {
    let matches = crate::resolver::full_matches(query, &tabs);
    if matches.len() > 1 {
        return Resolution::Choose(matches);
    }
    classify(query, tabs, Vec::new())
}

/// Retrouve l'onglet désigné ; seules les fenêtres de navigateur sont acceptées.
fn find_tab(a: &IUIAutomation, target: &str) -> Result<(HWND, IUIAutomationElement), String> {
    let mut parts = target.splitn(3, ':');
    let raw = parts.next().and_then(|h| h.parse::<isize>().ok()).ok_or("Onglet inconnu")?;
    let index: usize = parts.next().and_then(|i| i.parse().ok()).ok_or("Onglet inconnu")?;
    let title = parts.next().unwrap_or_default();
    let hwnd = browser_windows()
        .into_iter()
        .map(|(h, _)| h)
        .find(|h| h.0 as isize == raw)
        .ok_or("Cette fenêtre de navigateur n'est plus ouverte")?;
    let items = tab_items(a, hwnd);
    // L'onglet a pu changer de place depuis la liste : son titre fait foi.
    let tab = items
        .get(index)
        .filter(|el| clean_title(&name_of(el)) == title)
        .cloned()
        .or_else(|| items.into_iter().find(|el| clean_title(&name_of(el)) == title))
        .ok_or("Cet onglet n'est plus ouvert")?;
    Ok((hwnd, tab))
}

pub fn switch_to(target: &str) -> Result<(), String> {
    let a = automation()?;
    let (hwnd, tab) = find_tab(&a, target)?;
    select(&tab)?;
    crate::window_control::show(hwnd);
    Ok(())
}

pub fn close(target: &str) -> Result<(), String> {
    let a = automation()?;
    let (hwnd, tab) = find_tab(&a, target)?;
    // La croix de l'onglet (Firefox y ajoute parfois un bouton « couper le son » : on prend la bonne).
    let buttons = all(&a, &tab, UIA_ButtonControlTypeId);
    let close_button = buttons
        .iter()
        .find(|b| {
            let name = name_of(b).to_lowercase();
            name.contains("ferm") || name.contains("close")
        })
        .or(buttons.last());
    if let Some(button) = close_button {
        let invoked = unsafe {
            button.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId).and_then(|p| p.Invoke())
        };
        if invoked.is_ok() {
            return Ok(());
        }
    }
    // Onglet trop étroit pour montrer sa croix : on l'affiche, puis Ctrl+W.
    use windows::Win32::UI::Input::KeyboardAndMouse::{VIRTUAL_KEY, VK_CONTROL};
    select(&tab)?;
    crate::window_control::show(hwnd);
    std::thread::sleep(std::time::Duration::from_millis(150));
    let w = VIRTUAL_KEY(b'W' as u16);
    crate::system::send_keys(&[(VK_CONTROL, false), (w, false), (w, true), (VK_CONTROL, true)])
}

fn page_text(a: &IUIAutomation, root: &IUIAutomationElement) -> String {
    let Some(doc) = first(a, root, UIA_DocumentControlTypeId) else { return String::new() };
    unsafe {
        doc.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
            .and_then(|t| t.DocumentRange())
            .and_then(|r| r.GetText(MAX_PAGE_CHARS))
            .map(|s| s.to_string())
            .unwrap_or_default()
    }
}

/// Page affichée : dans la fenêtre que l'utilisateur regardait si c'est un navigateur, sinon dans
/// le navigateur le plus en avant. Titre, adresse et texte.
pub fn read_page(looking_at: HWND) -> Result<Page, String> {
    let a = automation()?;
    let windows = browser_windows();
    let (hwnd, browser) = windows
        .iter()
        .find(|(h, _)| *h == looking_at)
        .or(windows.first())
        .copied()
        .ok_or("Aucun navigateur n'est ouvert")?;
    let root = unsafe { a.ElementFromHandle(hwnd) }.map_err(|e| e.to_string())?;
    let title = tab_items(&a, hwnd)
        .iter()
        .find(|t| is_selected(t))
        .map(|t| clean_title(&name_of(t)).to_string())
        .unwrap_or_else(|| name_of(&root));
    // Le premier champ de saisie de la fenêtre est la barre d'adresse.
    let url = first(&a, &root, UIA_EditControlTypeId)
        .and_then(|e| unsafe { e.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }.ok())
        .and_then(|v| unsafe { v.CurrentValue() }.ok())
        .map(|s| s.to_string())
        .unwrap_or_default();
    let mut text = page_text(&a, &root);
    if text.trim().is_empty() {
        std::thread::sleep(ACCESSIBILITY_WARMUP);
        text = page_text(&a, &root);
    }
    Ok(Page { browser: browser.into(), title, url, text: text.trim().to_string() })
}

/// Nom du navigateur par défaut de Windows.
pub fn default_browser() -> Option<String> {
    let prog_id = read_string(
        HKEY_CURRENT_USER,
        r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice",
        "ProgId",
    )?;
    Some(prog_id_name(&prog_id))
}

fn prog_id_name(prog_id: &str) -> String {
    let id = prog_id.to_lowercase();
    let known = [
        ("brave", "Brave"),
        ("chrome", "Google Chrome"),
        ("msedge", "Microsoft Edge"),
        ("firefox", "Firefox"),
        ("opera", "Opera"),
        ("vivaldi", "Vivaldi"),
    ];
    known.iter().find(|(k, _)| id.contains(k)).map_or_else(|| prog_id.to_string(), |(_, n)| n.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_browsers_and_their_registry_names() {
        assert_eq!(browser_name("C:\\Users\\a\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"), Some("Brave"));
        assert_eq!(browser_name("C:\\Program Files\\Spotify\\Spotify.exe"), None);
        assert_eq!(prog_id_name("BraveHTML.W6ICIV3VR54SHUZ32O74UTISVY"), "Brave");
        assert_eq!(prog_id_name("ChromeHTML"), "Google Chrome");
        assert_eq!(prog_id_name("MSEdgeHTM"), "Microsoft Edge");
    }

    #[test]
    fn asks_when_several_tabs_match() {
        let tab = |title: &str, i: usize| Candidate::named(title, title, "tab", &format!("1:{i}:{title}"), "Brave");
        let tabs = vec![tab("YouTube", 0), tab("Squeezie - YouTube", 1), tab("Gmail", 2)];
        assert!(matches!(resolve_in("youtube", tabs.clone()), Resolution::Choose(ref c) if c.len() == 2));
        assert!(matches!(resolve_in("squeezie", tabs.clone()), Resolution::Open(ref c) if c.label == "Squeezie - YouTube"));
        assert!(matches!(resolve_in("gmail", tabs), Resolution::Open(_)));
    }

    #[test]
    fn tab_names_lose_the_hover_details() {
        assert_eq!(clean_title("YouTubeMusic - Utilisation de la mémoire - 194Mo"), "YouTubeMusic");
        assert_eq!(clean_title("Gmail - Audio playing - Memory usage - 80 MB"), "Gmail");
        assert_eq!(clean_title("Suits - Saison 3"), "Suits - Saison 3");
    }

    /// Dépend de la machine : `cargo test --lib real_tabs -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_tabs() {
        for c in candidates() {
            println!("{} ({}) → {}", c.label, c.detail, c.target);
        }
        match read_page(HWND::default()) {
            Ok(p) => println!("{} : {} caractères lus", p.browser, p.text.len()),
            Err(e) => println!("lecture impossible : {e}"),
        }
    }
}
