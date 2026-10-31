import { describe, expect, it } from "vitest";
import { claudeTools, geminiDeclarations, TOOLS } from "./index";

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
