import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../native", () => ({
  native: { findFiles: vi.fn(), openFile: vi.fn(async () => {}) },
}));

import { native } from "../native";
import { FILE_TOOLS, isProgram } from "./files";
import type { ToolContext } from "./types";

const openFile = FILE_TOOLS.find((t) => t.name === "open_file")!;
const findFile = FILE_TOOLS.find((t) => t.name === "find_file")!;

function context(confirmed: boolean) {
  const confirm = vi.fn(async () => confirmed);
  const ctx = {
    ui: { status() {}, text() {}, sources() {}, confirm },
    signal: new AbortController().signal,
    search: async () => ({ summary: "", sources: [] }),
  } as unknown as ToolContext;
  return { ctx, confirm };
}

beforeEach(() => vi.clearAllMocks());

describe("isProgram", () => {
  it("reconnaît les programmes quelle que soit la casse", () => {
    expect(isProgram("C:\\x\\Setup.EXE")).toBe(true);
    expect(isProgram("raccourci.lnk")).toBe(true);
    expect(isProgram("C:\\x\\app.appref-ms")).toBe(true);
  });

  it("laisse passer les documents", () => {
    expect(isProgram("photo.jpg")).toBe(false);
    expect(isProgram("C:\\x\\rapport.pdf")).toBe(false);
    expect(isProgram("sans-extension")).toBe(false);
  });
});

describe("open_file", () => {
  it("demande confirmation avant de lancer un programme, et n'ouvre rien si refus", async () => {
    const { ctx, confirm } = context(false);
    const result = await openFile.run({ path: "C:\\Users\\moi\\Downloads\\Setup.exe" }, ctx);
    expect(confirm).toHaveBeenCalledWith("Lancer Setup.exe ?", "Lancer");
    expect(result.ok).toBe(false);
    expect(native.openFile).not.toHaveBeenCalled();
  });

  it("lance le programme une fois confirmé", async () => {
    const { ctx } = context(true);
    const result = await openFile.run({ path: "C:\\Users\\moi\\Downloads\\Setup.exe" }, ctx);
    expect(result.ok).toBe(true);
    expect(native.openFile).toHaveBeenCalledWith("C:\\Users\\moi\\Downloads\\Setup.exe");
  });

  it("ouvre un document sans confirmation", async () => {
    const { ctx, confirm } = context(false);
    const result = await openFile.run({ path: "C:\\docs\\rapport.pdf" }, ctx);
    expect(confirm).not.toHaveBeenCalled();
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
