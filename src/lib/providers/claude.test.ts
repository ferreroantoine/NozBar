import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools")>()),
  executeTool: vi.fn(async (name: string) => ({ ok: true, message: `${name} fait` })),
}));

import type Anthropic from "@anthropic-ai/sdk";
import { executeTool, type Ui } from "../tools";
import { ClaudeProvider, CLAUDE_MODEL } from "./claude";

type Block = Record<string, unknown>;
interface FakeMessage {
  content: Block[];
  stop_reason: string;
}

/** Client simulé : chaque appel à stream() rejoue le message suivant de la liste. */
function fakeClient(messages: FakeMessage[]) {
  const stream = vi.fn((_body: Record<string, unknown>) => {
    const message = messages.shift()!;
    let onText: ((delta: string) => void) | undefined;
    const s = {
      on(event: string, listener: (delta: string) => void) {
        if (event === "text") onText = listener;
        return s;
      },
      async finalMessage() {
        for (const b of message.content) if (b.type === "text") onText?.(b.text as string);
        return message;
      },
    };
    return s;
  });
  return { client: { beta: { messages: { stream } } } as unknown as Anthropic, stream };
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
const body = (stream: ReturnType<typeof fakeClient>["stream"], call: number) =>
  stream.mock.calls[call][0] as unknown as { messages: Anthropic.Beta.BetaMessageParam[]; tools: Block[] } & Block;

beforeEach(() => vi.clearAllMocks());

describe("ClaudeProvider", () => {
  it("renvoie et diffuse une réponse texte", async () => {
    const { client } = fakeClient([{ content: [{ type: "text", text: "Bonjour" }], stop_reason: "end_turn" }]);
    const answer = await new ClaudeProvider("clé", client).send("Salut", ui, signal);
    expect(answer).toBe("Bonjour");
    expect(ui.text).toHaveBeenCalledWith("Bonjour");
  });

  it("renvoie tous les résultats d'outils dans un seul message", async () => {
    const { client, stream } = fakeClient([
      {
        content: [
          { type: "tool_use", id: "t1", name: "get_weather", input: { city: "Lyon" } },
          { type: "tool_use", id: "t2", name: "find_file", input: { query: "rapport" } },
        ],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "Voilà" }], stop_reason: "end_turn" },
    ]);
    const answer = await new ClaudeProvider("clé", client).send("Météo et rapport", ui, signal);
    expect(answer).toBe("Voilà");
    expect(executeTool).toHaveBeenCalledTimes(2);
    const last = body(stream, 1).messages.at(-1)!;
    expect(last.role).toBe("user");
    const results = last.content as unknown as Block[];
    expect(results.map((r) => [r.type, r.tool_use_id])).toEqual([
      ["tool_result", "t1"],
      ["tool_result", "t2"],
    ]);
  });

  it("répare l'historique quand une réponse est coupée au milieu d'un appel d'outil", async () => {
    const { client, stream } = fakeClient([
      {
        content: [
          { type: "text", text: "Je regarde" },
          { type: "tool_use", id: "t9", name: "find_file", input: {} },
        ],
        stop_reason: "max_tokens",
      },
      { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
    ]);
    const claude = new ClaudeProvider("clé", client);
    expect(await claude.send("Cherche", ui, signal)).toBe("Je regarde");
    expect(executeTool).not.toHaveBeenCalled();
    await claude.send("Et alors ?", ui, signal);
    const messages = body(stream, 1).messages;
    const repaired = messages[2].content as unknown as Block[];
    expect(repaired).toEqual([expect.objectContaining({ type: "tool_result", tool_use_id: "t9", is_error: true })]);
    expect(messages.at(-1)).toEqual({ role: "user", content: "Et alors ?" });
  });

  it("signale un refus", async () => {
    const { client } = fakeClient([{ content: [], stop_reason: "refusal" }]);
    await expect(new ClaudeProvider("clé", client).send("…", ui, signal)).rejects.toThrow("Claude a refusé cette demande.");
  });

  it("envoie Sonnet, le repli serveur et sa propre recherche web", async () => {
    const { client, stream } = fakeClient([{ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }]);
    await new ClaudeProvider("clé", client).send("Salut", ui, signal);
    const b = body(stream, 0);
    expect(b.model).toBe(CLAUDE_MODEL);
    expect(CLAUDE_MODEL).toBe("claude-sonnet-5-5");
    expect(b.fallbacks).toBe("default");
    expect(b.betas).toContain("server-side-fallback-2026-07-01");
    const webSearch = b.tools.filter((t) => t.name === "web_search");
    expect(webSearch).toEqual([expect.objectContaining({ type: "web_search_20260209" })]);
    expect(b.tools.map((t) => t.name)).not.toContain("ask_expert");
  });

  it("préfixe le contexte de la conversation au premier message seulement", async () => {
    const { client, stream } = fakeClient([
      { content: [{ type: "text", text: "Un" }], stop_reason: "end_turn" },
      { content: [{ type: "text", text: "Deux" }], stop_reason: "end_turn" },
    ]);
    const claude = new ClaudeProvider("clé", client);
    await claude.send("Explique X", ui, signal, "Utilisateur : bonjour\nAssistant : salut");
    await claude.send("Et Y ?", ui, signal);
    const first = body(stream, 0).messages[0].content as string;
    expect(first).toContain("Utilisateur : bonjour");
    expect(first).toContain("Explique X");
    expect(body(stream, 1).messages.at(-1)).toEqual({ role: "user", content: "Et Y ?" });
  });
});
