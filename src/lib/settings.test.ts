import { describe, expect, it, vi } from "vitest";
import { categoryOf, DEFAULT_SETTINGS, memoryPrompt, SettingsStore } from "./settings";

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
    expect(save).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, permissions: { ...DEFAULT_SETTINGS.permissions, commands: "always" } });
  });

  it("adopte les réglages reçus d'une autre fenêtre", () => {
    const store = new SettingsStore(async () => {});
    store.replace({ permissions: { ...DEFAULT_SETTINGS.permissions, programs: "never" }, memories: [] });
    expect(store.policy("programs")).toBe("never");
  });
});

describe("mémoire", () => {
  it("retient un fait une seule fois, accents et casse mis à part, et l'enregistre", async () => {
    const save = vi.fn(async () => {});
    const store = new SettingsStore(save);
    expect(await store.remember("Pour fermer Steam, ferme aussi steamwebhelper")).toBe(true);
    expect(await store.remember("pour fermer steam ferme aussi steamwebhelper.")).toBe(false);
    expect(store.memories).toEqual(["Pour fermer Steam, ferme aussi steamwebhelper"]);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("retrouve les souvenirs qui parlent d'un sujet, et les oublie", async () => {
    const store = new SettingsStore(async () => {});
    await store.remember("Pour fermer Steam, ferme aussi steamwebhelper");
    await store.remember("J'habite à Lyon");
    expect(store.memoriesAbout("steam")).toEqual(["Pour fermer Steam, ferme aussi steamwebhelper"]);
    expect(store.memoriesAbout("Spotify")).toEqual([]);
    await store.forget(0);
    expect(store.memories).toEqual(["J'habite à Lyon"]);
  });

  it("garde les souvenirs quand une règle change, et les ignore s'ils manquent (ancien fichier)", async () => {
    const store = new SettingsStore(async () => {});
    await store.remember("J'habite à Lyon");
    await store.setPolicy("commands", "never");
    expect(store.memories).toEqual(["J'habite à Lyon"]);
    store.replace({ permissions: DEFAULT_SETTINGS.permissions });
    expect(store.memories).toEqual([]);
  });

  it("rédige les souvenirs pour les consignes de l'IA", () => {
    expect(memoryPrompt([])).toBe("");
    expect(memoryPrompt(["J'habite à Lyon"])).toContain("- J'habite à Lyon");
  });
});
