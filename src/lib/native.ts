// Commandes Tauri exposées par le cœur Rust (src-tauri/src/lib.rs).

import { invoke } from "@tauri-apps/api/core";

export const native = {
  hideBubble: () => invoke<void>("hide_bubble"),
  getShortcut: () => invoke<string>("get_shortcut"),
  getApiKey: () => invoke<string | null>("get_api_key"),
  setApiKey: (key: string) => invoke<void>("set_api_key", { key }),
  openApp: (name: string) => invoke<{ name: string }>("open_app", { name }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  openSettings: (page: string) => invoke<void>("open_settings", { page }),
  mediaControl: (action: string) => invoke<void>("media_control", { action }),
  setVolume: (level?: number, delta?: number) =>
    invoke<number>("set_volume", { level: level ?? null, delta: delta ?? null }),
  setTimer: (seconds: number, title: string, body: string) =>
    invoke<void>("set_timer", { seconds, title, body }),
};
