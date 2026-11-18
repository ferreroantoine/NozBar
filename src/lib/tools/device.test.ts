import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../native", () => ({
  native: {
    resolveAudioOutput: vi.fn(),
    audioOutputs: vi.fn(),
    setAudioOutput: vi.fn(async () => {}),
    power: vi.fn(async () => {}),
    readClipboard: vi.fn(async () => "mot de passe"),
  },
}));

import { native } from "../native";
import { DEVICE_TOOLS } from "./device";
import { SCREEN_TOOLS } from "./screen";
import { reminderTime } from "./system";
import type { ToolContext } from "./types";

const tool = (name: string) => [...DEVICE_TOOLS, ...SCREEN_TOOLS].find((t) => t.name === name)!;

function context(opts: { origin?: "claude"; pick?: string | null; confirm?: boolean; permission?: "once" | "deny" } = {}) {
  const ask = vi.fn(async () => opts.pick ?? null);
  const confirm = vi.fn(async () => opts.confirm ?? true);
  const permission = vi.fn(async () => opts.permission ?? "once");
  const ctx = {
    ui: { status() {}, text() {}, sources() {}, ask, confirm, permission, expert() {} },
    signal: new AbortController().signal,
    origin: opts.origin,
    search: async () => ({ summary: "", sources: [] }),
  } as unknown as ToolContext;
  return { ctx, ask, confirm, permission };
}

beforeEach(() => vi.clearAllMocks());

describe("audio_output", () => {
  const jbl = { name: "Haut-parleurs (JBL Charge 5)", id: "jbl", default: true };
  const g733 = { name: "Haut-parleurs (Logitech G733 Gaming Headset)", id: "g733", default: false };

  it("passe directement sur la sortie reconnue", async () => {
    vi.mocked(native.resolveAudioOutput).mockResolvedValue({
      kind: "open",
      candidates: { label: g733.name, kind: "audio", target: "g733", detail: "sortie audio" },
    });
    const result = await tool("audio_output").run({ name: "casque" }, context().ctx);
    expect(native.setAudioOutput).toHaveBeenCalledWith("g733");
    expect(result.message).toContain("G733");
  });

  it("propose toutes les sorties quand le nom ne dit rien", async () => {
    vi.mocked(native.resolveAudioOutput).mockResolvedValue({ kind: "nothing" });
    vi.mocked(native.audioOutputs).mockResolvedValue([jbl, g733]);
    const { ctx, ask } = context({ pick: `${jbl.name} (actuelle)` });
    await tool("audio_output").run({ name: "la télé" }, ctx);
    expect(ask).toHaveBeenCalled();
    expect(native.setAudioOutput).toHaveBeenCalledWith("jbl");
  });
});

describe("power", () => {
  it("n'éteint jamais le PC sans confirmation", async () => {
    const { ctx, confirm } = context({ confirm: false });
    const result = await tool("power").run({ action: "shutdown" }, ctx);
    expect(confirm).toHaveBeenCalled();
    expect(native.power).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it("verrouille sans question pour l'utilisateur", async () => {
    const { ctx, confirm } = context();
    await tool("power").run({ action: "lock" }, ctx);
    expect(confirm).not.toHaveBeenCalled();
    expect(native.power).toHaveBeenCalledWith("lock");
  });
});

describe("lectures protégées", () => {
  it("demande l'accord avant que Claude Code lise le presse-papiers", async () => {
    const { ctx, permission } = context({ origin: "claude", permission: "deny" });
    const result = await tool("read_clipboard").run({}, ctx);
    expect(permission).toHaveBeenCalledWith("Claude veut lire ton presse-papiers", false);
    expect(native.readClipboard).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });
});

describe("reminderTime", () => {
  const now = new Date(2026, 10, 7, 14, 30);

  it("vise aujourd'hui, ou demain si l'heure est passée", () => {
    expect(reminderTime("18:00", now)).toEqual(new Date(2026, 10, 7, 18, 0));
    expect(reminderTime("18h", now)).toEqual(new Date(2026, 10, 7, 18, 0));
    expect(reminderTime("9h15", now)).toEqual(new Date(2026, 10, 8, 9, 15));
  });

  it("refuse une heure invalide", () => {
    expect(reminderTime("25:00", now)).toBeNull();
    expect(reminderTime("demain", now)).toBeNull();
  });
});
