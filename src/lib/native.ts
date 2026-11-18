// Commandes Tauri exposées par le cœur Rust (src-tauri/src/lib.rs).

import { Channel, invoke } from "@tauri-apps/api/core";
import type { Settings } from "./settings";

export type Provider = "gemini" | "anthropic" | "groq";

export interface OpenCandidate {
  label: string;
  kind: "app" | "file" | "tab" | "audio" | "game";
  /** Identifiant d'application, chemin complet, onglet, sortie audio ou jeu Steam. */
  target: string;
  detail: string;
}

export interface Page {
  browser: string;
  title: string;
  url: string;
  text: string;
}

export interface ProcessUsage {
  name: string;
  cpu: number;
  memory_mb: number;
}

export interface SystemStatus {
  cpu: number;
  memoryUsedGb: number;
  memoryTotalGb: number;
  byCpu: ProcessUsage[];
  byMemory: ProcessUsage[];
  battery: { percent: number; charging: boolean } | null;
}

export interface NowPlaying {
  title: string;
  artist: string;
  app: string;
  playing: boolean;
}

export type WindowAction = "focus" | "minimize" | "maximize" | "restore" | "left" | "right" | "next_screen";
export type PowerAction = "lock" | "sleep" | "shutdown" | "restart";

export type OpenResolution =
  | { kind: "open"; candidates: OpenCandidate }
  | { kind: "choose"; candidates: OpenCandidate[] }
  | { kind: "nothing" };

export interface FoundFile {
  name: string;
  path: string;
  folder: string;
  /** Secondes depuis l'époque Unix. */
  modified: number;
}

export const native = {
  hideBubble: () => invoke<void>("hide_bubble"),
  focusBubble: () => invoke<void>("focus_bubble"),
  getShortcut: () => invoke<string>("get_shortcut"),
  getApiKey: (provider: Provider) => invoke<string | null>("get_api_key", { provider }),
  setApiKey: (provider: Provider, key: string) => invoke<void>("set_api_key", { provider, key }),
  openApp: (name: string) => invoke<{ name: string }>("open_app", { name }),
  resolveOpen: (query: string) => invoke<OpenResolution>("resolve_open", { query }),
  launchApp: (appId: string) => invoke<void>("launch_app", { appId }),
  resolveClose: (query: string) => invoke<OpenResolution>("resolve_close", { query }),
  /** `background` : l'application restait en arrière-plan sans fenêtre, elle a été arrêtée. */
  closeApp: (target: string) => invoke<{ windows: number; background: boolean }>("close_app", { target }),
  /** Noms d'applications ouvertes et installées, pour que la transcription vocale les écrive juste. */
  speechHints: () => invoke<string[]>("speech_hints"),
  findFiles: (query: string, kind?: string) => invoke<FoundFile[]>("find_files", { query, kind: kind ?? null }),
  checkFile: (path: string) => invoke<{ name: string; needsConfirmation: boolean; inClaudeWorkspace: boolean }>("check_file", { path }),
  openFile: (path: string, confirmed: boolean) => invoke<void>("open_file", { path, confirmed }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  getLocation: () => invoke<{ lat: number; lon: number }>("get_location"),
  claudeCodeStatus: () => invoke<{ installed: boolean; loggedIn: boolean }>("claude_code_status"),
  /** Un tour de Claude Code ; chaque ligne JSON du flux arrive dans `onLine`. */
  claudeCodeSend: (prompt: string, model: string, resume: string | null, onLine: (line: string) => void) => {
    const channel = new Channel<string>();
    channel.onmessage = onLine;
    return invoke<void>("claude_code_send", { prompt, model, resume, onLine: channel });
  },
  claudeCodeCancel: () => invoke<void>("claude_code_cancel"),
  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (settings: Settings) => invoke<void>("set_settings", { settings }),
  openPreferences: () => invoke<void>("open_preferences"),
  claudeCodeLogin: () => invoke<void>("claude_code_login"),
  claudeCodeLogout: () => invoke<void>("claude_code_logout"),
  mcpSetTools: (tools: unknown[]) => invoke<void>("mcp_set_tools", { tools }),
  mcpReply: (id: number, text: string, isError: boolean) => invoke<void>("mcp_reply", { id, text, isError }),
  openSettings: (page: string) => invoke<void>("open_settings", { page }),
  mediaControl: (action: string) => invoke<void>("media_control", { action }),
  setVolume: (level?: number, delta?: number) =>
    invoke<number>("set_volume", { level: level ?? null, delta: delta ?? null }),
  setTimer: (seconds: number, title: string, body: string) =>
    invoke<void>("set_timer", { seconds, title, body }),

  resolveTab: (query: string) => invoke<OpenResolution>("resolve_tab", { query }),
  listTabs: () => invoke<OpenCandidate[]>("list_tabs"),
  switchTab: (target: string) => invoke<void>("switch_tab", { target }),
  closeTab: (target: string) => invoke<void>("close_tab", { target }),
  /** Page affichée dans le navigateur que l'utilisateur regardait. */
  readPage: () => invoke<Page>("read_page"),
  defaultBrowser: () => invoke<string | null>("default_browser"),
  windowAction: (target: string, action: WindowAction) => invoke<void>("window_action", { target, action }),
  showDesktop: () => invoke<void>("show_desktop"),
  /** Texte sélectionné dans la fenêtre que l'utilisateur regardait avant d'ouvrir la bulle. */
  getSelection: () => invoke<string>("get_selection"),
  readClipboard: () => invoke<string>("read_clipboard"),
  writeClipboard: (text: string) => invoke<void>("write_clipboard", { text }),
  /** Capture de l'écran que l'utilisateur regardait, sans la bulle (JPEG en base64). */
  captureScreen: () => invoke<string>("capture_screen"),
  audioOutputs: () => invoke<{ name: string; id: string; default: boolean }[]>("audio_outputs"),
  resolveAudioOutput: (query: string) => invoke<OpenResolution>("resolve_audio_output", { query }),
  setAudioOutput: (id: string) => invoke<void>("set_audio_output", { id }),
  /** Renvoie vrai si le micro est maintenant coupé ; sans `muted`, bascule. */
  setMicrophone: (muted?: boolean) => invoke<boolean>("set_microphone", { muted: muted ?? null }),
  setBrightness: (level?: number, delta?: number) =>
    invoke<number>("set_brightness", { level: level ?? null, delta: delta ?? null }),
  /** Renvoie vrai si le mode sombre est maintenant actif. */
  setDarkMode: (mode: "dark" | "light" | "toggle") => invoke<boolean>("set_dark_mode", { mode }),
  power: (action: PowerAction) => invoke<void>("power_action", { action }),
  systemStatus: () => invoke<SystemStatus>("system_status"),
  nowPlaying: () => invoke<NowPlaying | null>("now_playing"),
  resolveGame: (query: string) => invoke<OpenResolution>("resolve_game", { query }),
  launchGame: (appId: string) => invoke<void>("launch_game", { appId }),
  getAutostart: () => invoke<boolean>("get_autostart"),
  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),
};
