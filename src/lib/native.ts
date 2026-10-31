// Commandes Tauri exposées par le cœur Rust (src-tauri/src/lib.rs).

import { invoke } from "@tauri-apps/api/core";

export type Provider = "gemini" | "anthropic";

export interface FoundFile {
  name: string;
  path: string;
  folder: string;
  /** Secondes depuis l'époque Unix. */
  modified: number;
}

export const native = {
  hideBubble: () => invoke<void>("hide_bubble"),
  getShortcut: () => invoke<string>("get_shortcut"),
  getApiKey: (provider: Provider) => invoke<string | null>("get_api_key", { provider }),
  setApiKey: (provider: Provider, key: string) => invoke<void>("set_api_key", { provider, key }),
  openApp: (name: string) => invoke<{ name: string }>("open_app", { name }),
  findFiles: (query: string, kind?: string) => invoke<FoundFile[]>("find_files", { query, kind: kind ?? null }),
  openFile: (path: string) => invoke<void>("open_file", { path }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  getLocation: () => invoke<{ lat: number; lon: number }>("get_location"),
  openSettings: (page: string) => invoke<void>("open_settings", { page }),
  mediaControl: (action: string) => invoke<void>("media_control", { action }),
  setVolume: (level?: number, delta?: number) =>
    invoke<number>("set_volume", { level: level ?? null, delta: delta ?? null }),
  setTimer: (seconds: number, title: string, body: string) =>
    invoke<void>("set_timer", { seconds, title, body }),
};
