import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../native", () => ({
  native: { resolveOpen: vi.fn(), launchApp: vi.fn(async () => {}), checkFile: vi.fn(), openFile: vi.fn(async () => {}), setSettings: vi.fn(async () => {}) },
}));

import { native } from "../native";
import { matchLocal } from "../router";
import { NONE_OF_THESE, OPEN_TOOL } from "./open";
import type { ToolContext } from "./types";

const forza = { label: "Forza Horizon 6", kind: "app", target: "forza!App", detail: "application" } as const;
const launcher = { label: "horizon-launcher.exe", kind: "file", target: "C:\\D\\horizon-launcher.exe", detail: "Téléchargements" } as const;

function context(answer: string | null = null) {
  const ask = vi.fn(async () => answer);
  const ctx = {
    ui: { status() {}, text() {}, sources() {}, ask, confirm: async () => true, permission: async () => "once", expert() {} },
    signal: new AbortController().signal,
    search: async () => ({ summary: "", sources: [] }),
  } as unknown as ToolContext;
  return { ctx, ask };
}

beforeEach(() => vi.clearAllMocks());

describe("open_app", () => {
  it("lance directement une application qui correspond nettement", async () => {
    vi.mocked(native.resolveOpen).mockResolvedValue({ kind: "open", candidates: forza });
    const { ctx, ask } = context();
    const result = await OPEN_TOOL.run({ name: "forza horizon" }, ctx);
    expect(native.launchApp).toHaveBeenCalledWith("forza!App");
    expect(ask).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, message: "Forza Horizon 6 est ouvert" });
  });

  it("ouvre un fichier par la même voie que open_file (confirmation des programmes)", async () => {
    vi.mocked(native.resolveOpen).mockResolvedValue({ kind: "open", candidates: launcher });
    vi.mocked(native.checkFile).mockResolvedValue({ name: "horizon-launcher.exe", needsConfirmation: true, inClaudeWorkspace: false });
    const { ctx } = context();
    const confirm = vi.spyOn(ctx.ui, "permission");
    await OPEN_TOOL.run({ name: "horizon launcher" }, ctx);
    expect(confirm).toHaveBeenCalledWith("Lancer horizon-launcher.exe ?");
    expect(native.openFile).toHaveBeenCalledWith(launcher.target, true);
    expect(native.launchApp).not.toHaveBeenCalled();
  });

  it("demande en cas de doute et ouvre le choix de l'utilisateur", async () => {
    vi.mocked(native.resolveOpen).mockResolvedValue({ kind: "choose", candidates: [forza, launcher] });
    vi.mocked(native.checkFile).mockResolvedValue({ name: "horizon-launcher.exe", needsConfirmation: false, inClaudeWorkspace: false });
    const { ctx, ask } = context("horizon-launcher.exe (Téléchargements)");
    await OPEN_TOOL.run({ name: "horizon" }, ctx);
    expect(ask).toHaveBeenCalledWith(
      "Tu veux ouvrir lequel ?",
      ["Forza Horizon 6 (application)", "horizon-launcher.exe (Téléchargements)", NONE_OF_THESE],
      false,
    );
    expect(native.openFile).toHaveBeenCalledWith(launcher.target, false);
    expect(native.launchApp).not.toHaveBeenCalled();
  });

  it("n'ouvre rien si aucun ne convient, et laisse l'IA chercher", async () => {
    vi.mocked(native.resolveOpen).mockResolvedValue({ kind: "choose", candidates: [forza] });
    const { ctx } = context(NONE_OF_THESE);
    const result = await OPEN_TOOL.run({ name: "horizon launcher" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.data?.cancelled).toBeUndefined();
    expect(native.launchApp).not.toHaveBeenCalled();
  });

  it("s'arrête net quand l'utilisateur annule (Échap)", async () => {
    vi.mocked(native.resolveOpen).mockResolvedValue({ kind: "choose", candidates: [forza, launcher] });
    const { ctx } = context(null);
    const result = await OPEN_TOOL.run({ name: "horizon" }, ctx);
    expect(result).toMatchObject({ ok: false, data: { cancelled: true } });
  });

  it("signale quand rien ne correspond", async () => {
    vi.mocked(native.resolveOpen).mockResolvedValue({ kind: "nothing" });
    const result = await OPEN_TOOL.run({ name: "photoshop" }, context().ctx);
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain("photoshop");
  });
});

describe("routeur « ouvre »", () => {
  it("retire les précisions de lieu de la phrase", () => {
    expect(matchLocal("ouvre horzon launcher il est dans mes telechargement")).toMatchObject({
      kind: "tool",
      name: "open_app",
      args: { name: "horzon launcher" },
    });
    expect(matchLocal("lance le launcher qui est sur mon bureau")).toMatchObject({ args: { name: "launcher" } });
    expect(matchLocal("ouvre spotify")).toMatchObject({ args: { name: "spotify" } });
  });
});
