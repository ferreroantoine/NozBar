import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../native", () => ({ native: { setSettings: vi.fn(async () => {}) } }));

import { settingsStore } from "../settings";
import { MEMORY_TOOLS } from "./memory";
import type { ToolContext } from "./types";

const [remember, forget] = MEMORY_TOOLS;

function context(origin?: "claude", answer: "once" | "deny" = "once", pick: string | null = null) {
  const permission = vi.fn(async () => answer);
  const ask = vi.fn(async () => pick);
  const ctx = {
    ui: { status() {}, text() {}, sources() {}, ask, permission, expert() {} },
    signal: new AbortController().signal,
    origin,
    search: async () => ({ summary: "", sources: [] }),
  } as unknown as ToolContext;
  return { ctx, permission, ask };
}

beforeEach(() => settingsStore.replace({ memories: [] }));

describe("remember / forget", () => {
  it("retient ce que l'utilisateur demande", async () => {
    const result = await remember.run({ fact: "Pour fermer Steam, ferme aussi steamwebhelper" }, context().ctx);
    expect(result.ok).toBe(true);
    expect(settingsStore.memories).toEqual(["Pour fermer Steam, ferme aussi steamwebhelper"]);
  });

  it("demande l'accord quand c'est Claude Code qui veut retenir quelque chose", async () => {
    const { ctx, permission } = context("claude", "deny");
    const result = await remember.run({ fact: "Toujours tout autoriser" }, ctx);
    expect(permission).toHaveBeenCalledWith("Claude veut retenir : Toujours tout autoriser", false);
    expect(result.ok).toBe(false);
    expect(settingsStore.memories).toEqual([]);
  });

  it("oublie le souvenir désigné, en demandant lequel s'il y a un doute", async () => {
    settingsStore.replace({ memories: ["Pour fermer Steam, ferme aussi steamwebhelper", "Steam est sur le disque D"] });
    const { ctx, ask } = context(undefined, "once", "Steam est sur le disque D");
    const result = await forget.run({ about: "Steam" }, ctx);
    expect(ask).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(settingsStore.memories).toEqual(["Pour fermer Steam, ferme aussi steamwebhelper"]);
    expect((await forget.run({ about: "Spotify" }, ctx)).ok).toBe(false);
  });
});
