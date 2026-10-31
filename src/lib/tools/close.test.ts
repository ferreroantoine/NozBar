import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../native", () => ({ native: { resolveClose: vi.fn(), closeApp: vi.fn(async () => 2) } }));

import { native } from "../native";
import { matchLocal } from "../router";
import { CLOSE_TOOL } from "./close";
import { NONE_OF_THESE } from "./open";
import type { ToolContext } from "./types";

const brave = { label: "brave", kind: "app", target: "exe:c:\\brave.exe", detail: "2 fenêtres" } as const;
const clyde = { label: "Clyde", kind: "app", target: "exe:c:\\clyde.exe", detail: "ouverte" } as const;

function context(answer: string | null = null) {
  const ask = vi.fn(async () => answer);
  const confirm = vi.fn(async () => true);
  const ctx = {
    ui: { status() {}, text() {}, sources() {}, ask, confirm, expert() {} },
    signal: new AbortController().signal,
    search: async () => ({ summary: "", sources: [] }),
  } as unknown as ToolContext;
  return { ctx, ask, confirm };
}

beforeEach(() => vi.clearAllMocks());

describe("close_app", () => {
  it("ferme proprement l'application qui correspond, sans confirmation", async () => {
    vi.mocked(native.resolveClose).mockResolvedValue({ kind: "open", candidates: brave });
    const { ctx, confirm } = context();
    const result = await CLOSE_TOOL.run({ name: "brave" }, ctx);
    expect(native.closeApp).toHaveBeenCalledWith(brave.target);
    expect(confirm).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, message: "brave est fermé" });
  });

  it("demande confirmation quand c'est Claude qui veut fermer une application", async () => {
    vi.mocked(native.resolveClose).mockResolvedValue({ kind: "open", candidates: brave });
    const { ctx } = context();
    const permission = vi.fn(async () => "deny" as const);
    const result = await CLOSE_TOOL.run({ name: "brave" }, { ...ctx, origin: "claude", ui: { ...ctx.ui, permission } });
    expect(permission).toHaveBeenCalledWith("Claude veut fermer brave (2 fenêtres)", false);
    expect(result.ok).toBe(false);
    expect(native.closeApp).not.toHaveBeenCalled();
  });

  it("demande laquelle en cas de doute", async () => {
    vi.mocked(native.resolveClose).mockResolvedValue({ kind: "choose", candidates: [brave, clyde] });
    const { ctx, ask } = context("Clyde (ouverte)");
    await CLOSE_TOOL.run({ name: "c" }, ctx);
    expect(ask).toHaveBeenCalledWith("Tu veux fermer laquelle ?", ["brave (2 fenêtres)", "Clyde (ouverte)", NONE_OF_THESE], false);
    expect(native.closeApp).toHaveBeenCalledWith(clyde.target);
  });

  it("s'arrête net si l'utilisateur annule", async () => {
    vi.mocked(native.resolveClose).mockResolvedValue({ kind: "choose", candidates: [brave, clyde] });
    const result = await CLOSE_TOOL.run({ name: "c" }, context(null).ctx);
    expect(result).toMatchObject({ ok: false, data: { cancelled: true } });
    expect(native.closeApp).not.toHaveBeenCalled();
  });

  it("signale quand aucune application ouverte ne correspond", async () => {
    vi.mocked(native.resolveClose).mockResolvedValue({ kind: "nothing" });
    const result = await CLOSE_TOOL.run({ name: "photoshop" }, context().ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("photoshop");
  });
});

describe("routeur « ferme »", () => {
  it("reconnaît fermer et quitter", () => {
    expect(matchLocal("ferme brave")).toMatchObject({ kind: "tool", name: "close_app", args: { name: "brave" } });
    expect(matchLocal("quitte la calculatrice")).toMatchObject({ name: "close_app", args: { name: "calculatrice" } });
    expect(matchLocal("ferme la fenêtre de spotify")).toMatchObject({ args: { name: "spotify" } });
  });
});
