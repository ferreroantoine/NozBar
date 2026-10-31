import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../native", () => ({
  native: { findFiles: vi.fn(), checkFile: vi.fn(), openFile: vi.fn(async () => {}), setSettings: vi.fn(async () => {}) },
}));

import { native } from "../native";
import { settingsStore } from "../settings";
import { FILE_TOOLS } from "./files";
import type { ToolContext } from "./types";

const openFile = FILE_TOOLS.find((t) => t.name === "open_file")!;
const findFile = FILE_TOOLS.find((t) => t.name === "find_file")!;

function context(confirmed: boolean | "always") {
  const confirm = vi.fn(async (_m: string) => (confirmed === "always" ? "always" : confirmed ? "once" : "deny"));
  const ctx = {
    ui: { status() {}, text() {}, sources() {}, permission: confirm },
    signal: new AbortController().signal,
    search: async () => ({ summary: "", sources: [] }),
  } as unknown as ToolContext;
  return { ctx, confirm };
}

beforeEach(() => vi.clearAllMocks());

describe("open_file", () => {
  it("demande confirmation quand le cœur Rust l'exige, avec le nom réel, et n'ouvre rien si refus", async () => {
    // « Setup.exe. » : Windows l'ouvre comme Setup.exe, c'est le nom résolu qui compte.
    vi.mocked(native.checkFile).mockResolvedValue({ name: "Setup.exe", needsConfirmation: true, inClaudeWorkspace: false });
    const { ctx, confirm } = context(false);
    const result = await openFile.run({ path: "C:\\Users\\moi\\Downloads\\Setup.exe." }, ctx);
    expect(confirm).toHaveBeenCalledWith("Lancer Setup.exe ?", true);
    expect(result.ok).toBe(false);
    expect(native.openFile).not.toHaveBeenCalled();
  });

  it("lance sans demander quand « Lancer des programmes » est sur Toujours", async () => {
    vi.mocked(native.checkFile).mockResolvedValue({ name: "Setup.exe", needsConfirmation: true, inClaudeWorkspace: false });
    await settingsStore.setPolicy("programs", "always");
    const { ctx, confirm } = context(false);
    const result = await openFile.run({ path: "C:\\D\\Setup.exe" }, ctx);
    expect(confirm).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    await settingsStore.setPolicy("programs", "ask");
  });

  it("refuse sans demander quand « Lancer des programmes » est sur Refuser", async () => {
    vi.mocked(native.checkFile).mockResolvedValue({ name: "Setup.exe", needsConfirmation: true, inClaudeWorkspace: false });
    await settingsStore.setPolicy("programs", "never");
    const { ctx, confirm } = context(true);
    const result = await openFile.run({ path: "C:\\D\\Setup.exe" }, ctx);
    expect(confirm).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(native.openFile).not.toHaveBeenCalled();
    await settingsStore.setPolicy("programs", "ask");
  });

  it("refuse à Claude un programme de son propre dossier, quelle que soit la règle", async () => {
    vi.mocked(native.checkFile).mockResolvedValue({ name: "maj.bat", needsConfirmation: true, inClaudeWorkspace: true });
    await settingsStore.setPolicy("programs", "always");
    const { ctx, confirm } = context(true);
    const result = await openFile.run({ path: "C:\\Users\\moi\\Documents\\NozBar\\maj.bat" }, { ...ctx, origin: "claude" });
    expect(result.ok).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(native.openFile).not.toHaveBeenCalled();
    await settingsStore.setPolicy("programs", "ask");
  });

  it("« Toujours autoriser » retient la règle des programmes", async () => {
    vi.mocked(native.checkFile).mockResolvedValue({ name: "Setup.exe", needsConfirmation: true, inClaudeWorkspace: false });
    const { ctx } = context("always");
    await openFile.run({ path: "C:\\D\\Setup.exe" }, ctx);
    expect(settingsStore.policy("programs")).toBe("always");
    await settingsStore.setPolicy("programs", "ask");
  });

  it("transmet la confirmation au cœur Rust", async () => {
    vi.mocked(native.checkFile).mockResolvedValue({ name: "Setup.exe", needsConfirmation: true, inClaudeWorkspace: false });
    const { ctx } = context(true);
    const result = await openFile.run({ path: "C:\\D\\Setup.exe" }, ctx);
    expect(result.ok).toBe(true);
    expect(native.openFile).toHaveBeenCalledWith("C:\\D\\Setup.exe", true);
  });

  it("ouvre un document sans confirmation", async () => {
    vi.mocked(native.checkFile).mockResolvedValue({ name: "rapport.pdf", needsConfirmation: false, inClaudeWorkspace: false });
    const { ctx, confirm } = context(false);
    const result = await openFile.run({ path: "C:\\docs\\rapport.pdf" }, ctx);
    expect(confirm).not.toHaveBeenCalled();
    expect(native.openFile).toHaveBeenCalledWith("C:\\docs\\rapport.pdf", false);
    expect(result.ok).toBe(true);
  });
});

describe("find_file", () => {
  it("renvoie les fichiers trouvés avec leur chemin", async () => {
    vi.mocked(native.findFiles).mockResolvedValue([
      { name: "horizon-launcher.exe", path: "C:\\D\\horizon-launcher.exe", folder: "Téléchargements", modified: 1 },
    ]);
    const { ctx } = context(true);
    const result = await findFile.run({ query: "horzon launcher", kind: "program" }, ctx);
    expect(native.findFiles).toHaveBeenCalledWith("horzon launcher", "program");
    expect(result.ok).toBe(true);
    expect(result.data?.files).toEqual([{ name: "horizon-launcher.exe", path: "C:\\D\\horizon-launcher.exe", folder: "Téléchargements" }]);
  });

  it("échoue clairement quand rien ne correspond", async () => {
    vi.mocked(native.findFiles).mockResolvedValue([]);
    const { ctx } = context(true);
    const result = await findFile.run({ query: "photoshop" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("photoshop");
  });
});
