import { describe, expect, it, vi } from "vitest";
import { claudeTools, executeTool, geminiDeclarations, TOOLS, type ToolContext } from "./index";

describe("executeTool", () => {
  it("n'exécute pas un outil dont le tour a été annulé pendant l'attente d'affichage", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
    const tool = TOOLS.find((t) => t.name === "set_timer")!;
    const run = vi.spyOn(tool, "run");
    const ctrl = new AbortController();
    const ctx = { ui: { status: () => ctrl.abort() }, signal: ctrl.signal } as unknown as ToolContext;
    await expect(executeTool("set_timer", { seconds: 5 }, ctx)).rejects.toThrow("Annulé");
    expect(run).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("catalogue d'outils", () => {
  it("décrit les outils pour Gemini en JSON Schema", () => {
    const openApp = geminiDeclarations().find((d) => d.name === "open_app");
    expect(openApp?.parametersJsonSchema).toMatchObject({ type: "object", required: ["name"] });
    expect(openApp?.parameters).toBeUndefined();
  });

  it("décrit les outils pour Claude, sans les outils exclus", () => {
    const tools = claudeTools(["web_search"]);
    expect(tools.map((t) => t.name)).not.toContain("web_search");
    expect(tools.length).toBe(TOOLS.length - 1);
    for (const tool of tools) {
      expect(tool.input_schema.type).toBe("object");
      expect(tool.eager_input_streaming).toBe(true);
    }
  });

  it("n'a pas deux outils du même nom", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
