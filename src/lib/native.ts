// Commandes Tauri exposées par le cœur Rust (src-tauri/src/lib.rs).

import { Channel, invoke } from "@tauri-apps/api/core";
import type { Settings } from "./settings";

export type Provider = "gemini" | "anthropic";

export interface OpenCandidate {
  label: string;
  kind: "app" | "file";
  /** Identifiant d'application ou chemin complet. */
  target: string;
  detail: string;
}

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
  closeApp: (target: string) => invoke<number>("close_app", { target }),
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
};
