import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools")>()),
  executeTool: vi.fn(async (name: string) =>
    name === "ask_expert" ? { ok: false, message: "Expert indisponible" } : { ok: true, message: "fait" },
  ),
}));

import type { GoogleGenAI, Part } from "@google/genai";
import { executeTool, type Ui } from "../tools";
import { GeminiProvider } from "./gemini";

/** Client simulé : chaque appel rejoue la liste de parts suivante, en un seul morceau de flux. */
function fakeAi(responses: Part[][]) {
  const generateContentStream = vi.fn(async () =>
    (async function* () {
      yield { candidates: [{ content: { parts: responses.shift()! } }] };
    })(),
  );
  return { ai: { models: { generateContentStream } } as unknown as GoogleGenAI, generateContentStream };
}

const ui: Ui = {
  status: vi.fn(),
  text: vi.fn(),
  sources: vi.fn(),
  confirm: async () => true,
  ask: async () => null,
  expert: vi.fn(),
};
const signal = new AbortController().signal;

beforeEach(() => vi.clearAllMocks());

describe("GeminiProvider", () => {
  it("demande le passage de main sans exécuter les autres outils du même message", async () => {
    const { ai } = fakeAi([
      [
        { functionCall: { name: "ask_expert", args: { task: "expliquer X" } } },
        { functionCall: { name: "open_app", args: { name: "Spotify" } } },
      ],
    ]);
    const reply = await new GeminiProvider("clé", ai).send("Explique X", ui, signal, true);
    expect(reply).toEqual({ handoff: "expliquer X" });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("transmet à l'expert les actions déjà faites pendant le tour", async () => {
    const { ai } = fakeAi([
      [{ functionCall: { name: "set_timer", args: { seconds: 300 } } }],
      [{ functionCall: { name: "ask_expert", args: { task: "expliquer X" } } }],
    ]);
    const reply = await new GeminiProvider("clé", ai).send("Minuteur 5 min et explique X", ui, signal, true);
    expect(reply).toEqual({ handoff: expect.stringContaining("expliquer X") });
    const handoff = (reply as { handoff: string }).handoff;
    expect(handoff).toContain('set_timer {"seconds":300}');
    expect(handoff).toContain("fait");
  });

  it("répond lui-même quand le passage de main est impossible", async () => {
    const { ai, generateContentStream } = fakeAi([
      [{ functionCall: { name: "ask_expert", args: { task: "expliquer X" } } }],
      [{ text: "Je réponds moi-même" }],
    ]);
    const reply = await new GeminiProvider("clé", ai).send("Explique X", ui, signal, false);
    expect(reply).toEqual({ answer: "Je réponds moi-même" });
    expect(executeTool).toHaveBeenCalledWith("ask_expert", { task: "expliquer X" }, expect.anything());
    expect(generateContentStream).toHaveBeenCalledTimes(2);
  });

  it("oublie le tour transmis à l'expert", async () => {
    const { ai, generateContentStream } = fakeAi([
      [{ functionCall: { name: "ask_expert", args: { task: "x" } } }],
      [{ text: "ok" }],
    ]);
    const gemini = new GeminiProvider("clé", ai);
    await gemini.send("Question difficile", ui, signal, true);
    await gemini.send("Autre", ui, signal, true);
    const contents = (generateContentStream.mock.calls[1] as unknown as [{ contents: unknown[] }])[0].contents;
    expect(contents).toHaveLength(1);
  });
});
