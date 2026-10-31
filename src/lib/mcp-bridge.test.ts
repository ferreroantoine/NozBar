import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tools")>()),
  executeTool: vi.fn(async () => ({ ok: true, message: "Lyon : 12 °C", data: { temp: 12 } })),
}));

import { describeRequest, handleMcpCall, mcpToolList } from "./mcp-bridge";
import { executeTool, type Ui } from "./tools";

function turn(confirmed: boolean) {
  const confirm = vi.fn(async () => confirmed);
  const ui = { status: vi.fn(), text: vi.fn(), sources: vi.fn(), confirm, ask: async () => null, expert: vi.fn() } satisfies Ui;
  return { active: { ui, signal: new AbortController().signal }, confirm };
}

// Entrée réelle reçue de Claude Code 2.1.310 pour une commande Bash.
const BASH = {
  tool_name: "Bash",
  input: { command: "echo ok > C:/tmp/x.txt", description: "Écrit un fichier" },
  tool_use_id: "toolu_1",
};

beforeEach(() => vi.clearAllMocks());

describe("handleMcpCall", () => {
  it("demande l'autorisation dans la bulle et la transmet à Claude Code", async () => {
    const { active, confirm } = turn(true);
    const out = await handleMcpCall({ id: 1, name: "approve", args: BASH }, active);
    expect(confirm).toHaveBeenCalledWith("Claude veut exécuter : echo ok > C:/tmp/x.txt", "Autoriser");
    expect(out.isError).toBe(false);
    expect(JSON.parse(out.text)).toEqual({ behavior: "allow", updatedInput: BASH.input });
  });

  it("transmet un refus", async () => {
    const { active } = turn(false);
    const out = await handleMcpCall({ id: 2, name: "approve", args: BASH }, active);
    expect(JSON.parse(out.text)).toMatchObject({ behavior: "deny" });
  });

  it("exécute les outils NozBar dans le tour en cours", async () => {
    const { active } = turn(true);
    const out = await handleMcpCall({ id: 3, name: "get_weather", args: { city: "Lyon" } }, active);
    expect(executeTool).toHaveBeenCalledWith("get_weather", { city: "Lyon" }, expect.objectContaining({ ui: active.ui }));
    expect(out).toEqual({ text: JSON.stringify({ message: "Lyon : 12 °C", temp: 12 }), isError: false });
  });

  it("refuse tout quand aucun tour n'est en cours (bulle fermée)", async () => {
    const approve = await handleMcpCall({ id: 4, name: "approve", args: BASH }, null);
    expect(JSON.parse(approve.text)).toMatchObject({ behavior: "deny" });
    const tool = await handleMcpCall({ id: 5, name: "get_weather", args: {} }, null);
    expect(tool.isError).toBe(true);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("refuse les outils hors catalogue", async () => {
    const { active } = turn(true);
    const out = await handleMcpCall({ id: 6, name: "web_search", args: { query: "x" } }, active);
    expect(out.isError).toBe(true);
    expect(executeTool).not.toHaveBeenCalled();
  });
});

describe("describeRequest", () => {
  it("formule la demande selon l'outil", () => {
    expect(describeRequest("Write", { file_path: "C:\\Users\\moi\\Desktop\\notes.md" })).toBe(
      "Claude veut écrire : C:\\Users\\moi\\Desktop\\notes.md",
    );
    expect(describeRequest("WebFetch", { url: "https://exemple.fr" })).toBe("Claude veut utiliser WebFetch");
  });
});

describe("mcpToolList", () => {
  it("expose le catalogue sans la recherche Google ni le passage de main", () => {
    const names = mcpToolList().map((t) => t.name);
    expect(names).toContain("get_weather");
    expect(names).toContain("ask_user");
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("ask_expert");
    expect(mcpToolList()[0]).toHaveProperty("inputSchema.type", "object");
  });
});
