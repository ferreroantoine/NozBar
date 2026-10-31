import { describe, expect, it, vi } from "vitest";
import { categoryOf, DEFAULT_SETTINGS, SettingsStore } from "./settings";

describe("categoryOf", () => {
  it("range chaque outil de Claude Code dans sa catégorie", () => {
    expect(categoryOf("Bash")).toBe("commands");
    expect(categoryOf("PowerShell")).toBe("commands");
    expect(categoryOf("Write")).toBe("write_outside");
    expect(categoryOf("Edit")).toBe("write_outside");
    expect(categoryOf("Read")).toBe("read_outside");
    expect(categoryOf("Grep")).toBe("read_outside");
    expect(categoryOf("WebFetch")).toBe("web_fetch");
    expect(categoryOf("WebSearch")).toBe("web_search");
    expect(categoryOf("Task")).toBeNull();
  });
});

describe("SettingsStore", () => {
  it("part des valeurs par défaut et enregistre un changement de règle", async () => {
    const save = vi.fn(async () => {});
    const store = new SettingsStore(save);
    expect(store.policy("commands")).toBe("ask");
    await store.setPolicy("commands", "always");
    expect(store.policy("commands")).toBe("always");
    expect(save).toHaveBeenCalledWith({ permissions: { ...DEFAULT_SETTINGS.permissions, commands: "always" } });
  });

  it("adopte les réglages reçus d'une autre fenêtre", () => {
    const store = new SettingsStore(async () => {});
    store.replace({ permissions: { ...DEFAULT_SETTINGS.permissions, programs: "never" } });
    expect(store.policy("programs")).toBe("never");
  });
});
