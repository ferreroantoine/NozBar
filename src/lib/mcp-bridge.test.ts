import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tools")>()),
  executeTool: vi.fn(async () => ({ ok: true, message: "Lyon : 12 °C", data: { temp: 12 } })),
}));

vi.mock("./native", () => ({ native: { checkFile: vi.fn() } }));

import { describeRequest, handleMcpCall, mcpToolList } from "./mcp-bridge";
import { native } from "./native";
import { SettingsStore } from "./settings";
import { executeTool, type Ui } from "./tools";

/** Tour actif dont l'utilisateur répond `answer` aux demandes d'autorisation. */
function turn(answer: boolean | "always") {
  const reply = answer === "always" ? "always" : answer ? "once" : "deny";
  const confirm = vi.fn(async (_message: string, _remember: boolean) => reply as "once" | "always" | "deny");
  const ui = {
    status: vi.fn(),
    text: vi.fn(),
    sources: vi.fn(),
    confirm: async () => answer !== false,
    permission: confirm,
    ask: async () => null,
    expert: vi.fn(),
  } satisfies Ui;
  return { active: { ui, signal: new AbortController().signal }, confirm };
}

const store = () => new SettingsStore(async () => {});

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
    expect(confirm).toHaveBeenCalledWith("Claude veut exécuter : echo ok > C:/tmp/x.txt", true);
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

describe("handleMcpCall — règles des paramètres", () => {
  it("autorise sans demander quand la règle est « Toujours »", async () => {
    const s = store();
    await s.setPolicy("commands", "always");
    const { active, confirm } = turn(false);
    const out = await handleMcpCall({ id: 20, name: "approve", args: BASH }, active, s);
    expect(confirm).not.toHaveBeenCalled();
    expect(JSON.parse(out.text)).toMatchObject({ behavior: "allow" });
  });

  it("refuse sans demander quand la règle est « Refuser »", async () => {
    const s = store();
    await s.setPolicy("commands", "never");
    const { active, confirm } = turn(true);
    const out = await handleMcpCall({ id: 21, name: "approve", args: BASH }, active, s);
    expect(confirm).not.toHaveBeenCalled();
    expect(JSON.parse(out.text)).toMatchObject({ behavior: "deny" });
  });

  it("« Toujours autoriser » dans la bulle enregistre la règle de la catégorie", async () => {
    const s = store();
    const { active } = turn("always");
    const out = await handleMcpCall({ id: 22, name: "approve", args: BASH }, active, s);
    expect(JSON.parse(out.text)).toMatchObject({ behavior: "allow" });
    expect(s.policy("commands")).toBe("always");
  });
});

describe("handleMcpCall — outils sans catégorie", () => {
  it("ne propose pas « Toujours autoriser » pour un outil sans réglage", async () => {
    const { active, confirm } = turn(true);
    await handleMcpCall({ id: 30, name: "approve", args: { tool_name: "Task", input: {} } }, active, store());
    expect(confirm).toHaveBeenCalledWith("Claude veut utiliser Task", false);
  });

  it("propose « Toujours autoriser » pour une catégorie connue", async () => {
    const { active, confirm } = turn(true);
    await handleMcpCall({ id: 31, name: "approve", args: BASH }, active, store());
    expect(confirm).toHaveBeenCalledWith("Claude veut exécuter : echo ok > C:/tmp/x.txt", true);
  });

  it("marque les outils exécutés pour Claude", async () => {
    const { active } = turn(true);
    await handleMcpCall({ id: 32, name: "get_weather", args: {} }, active, store());
    expect(executeTool).toHaveBeenCalledWith("get_weather", {}, expect.objectContaining({ origin: "claude" }));
  });
});

describe("handleMcpCall — garde-fous", () => {
  it("montre la commande en entier, et refuse une commande trop longue pour être relue", async () => {
    const { active, confirm } = turn(true);
    const long = `echo ${"a".repeat(300)} && del important.txt`;
    await handleMcpCall({ id: 7, name: "approve", args: { tool_name: "Bash", input: { command: long } } }, active);
    expect(confirm).toHaveBeenCalledWith(`Claude veut exécuter : ${long}`, true);

    const huge = "x".repeat(3000);
    const out = await handleMcpCall({ id: 8, name: "approve", args: { tool_name: "Bash", input: { command: huge } } }, active);
    expect(JSON.parse(out.text)).toMatchObject({ behavior: "deny" });
  });

  it("refuse de lancer un programme créé dans le dossier de Claude", async () => {
    vi.mocked(native.checkFile).mockResolvedValue({ name: "x.bat", needsConfirmation: true, inClaudeWorkspace: true });
    const { active } = turn(true);
    const out = await handleMcpCall({ id: 9, name: "open_file", args: { path: "C:\\Users\\moi\\Documents\\NozBar\\x.bat" } }, active);
    expect(out.isError).toBe(true);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("laisse ouvrir un document du dossier de Claude", async () => {
    vi.mocked(native.checkFile).mockResolvedValue({ name: "notes.md", needsConfirmation: false, inClaudeWorkspace: true });
    const { active } = turn(true);
    await handleMcpCall({ id: 10, name: "open_file", args: { path: "C:\\N\\notes.md" } }, active);
    expect(executeTool).toHaveBeenCalled();
  });
});

describe("describeRequest", () => {
  it("décrit une lecture hors du dossier de travail", () => {
    expect(describeRequest("Read", { file_path: "C:\\Users\\moi\\.ssh\\id_rsa" })).toBe(
      "Claude veut lire : C:\\Users\\moi\\.ssh\\id_rsa",
    );
  });

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
