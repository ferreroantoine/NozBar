import { describe, expect, it, vi } from "vitest";
import { Conversation, forcedExpert, type ClaudeLike, type GeminiLike } from "./conversation";
import type { Ui } from "./tools";

function makeUi() {
  return {
    status: vi.fn(),
    text: vi.fn(),
    sources: vi.fn(),
    confirm: async () => true,
    ask: async () => null,
    expert: vi.fn<() => void>(),
  } satisfies Ui;
}

const signal = new AbortController().signal;

function fakes(geminiReplies: Awaited<ReturnType<GeminiLike["send"]>>[]) {
  const gemini = {
    send: vi.fn(async (..._args: Parameters<GeminiLike["send"]>) => geminiReplies.shift()!),
    reset: vi.fn(),
    search: vi.fn(),
    transcribe: vi.fn(),
  } satisfies GeminiLike;
  const claude = { send: vi.fn(async () => "Réponse de Sonnet"), reset: vi.fn() } satisfies ClaudeLike;
  return { gemini, claude };
}

describe("Conversation", () => {
  it("passe la main à Claude avec l'échange précédent quand Gemini le demande", async () => {
    const { gemini, claude } = fakes([{ answer: "Salut !" }, { handoff: "expliquer les masques de fusion" }]);
    const conversation = new Conversation(gemini, () => claude);
    const ui = makeUi();
    await conversation.send("Bonjour", ui, signal);
    const answer = await conversation.send("Comment faire un masque de fusion ?", ui, signal);

    expect(answer).toBe("Réponse de Sonnet");
    expect(ui.expert).toHaveBeenCalledOnce();
    expect(conversation.expert).toBe(true);
    const [text, , , context] = claude.send.mock.calls[0] as unknown as [string, Ui, AbortSignal, string];
    expect(text).toContain("Comment faire un masque de fusion ?");
    expect(text).toContain("expliquer les masques de fusion");
    expect(context).toBe("Utilisateur : Bonjour\nAssistant : Salut !");
  });

  it("garde Claude jusqu'au reset, puis revient à Gemini", async () => {
    const { gemini, claude } = fakes([{ handoff: "x" }, { answer: "Gemini" }]);
    const conversation = new Conversation(gemini, () => claude);
    await conversation.send("Question difficile", makeUi(), signal);
    await conversation.send("Et ensuite ?", makeUi(), signal);
    expect(claude.send).toHaveBeenCalledTimes(2);
    expect(gemini.send).toHaveBeenCalledTimes(1);

    conversation.reset();
    expect(conversation.expert).toBe(false);
    expect(claude.reset).toHaveBeenCalled();
    expect(await conversation.send("Quelle heure ?", makeUi(), signal)).toBe("Gemini");
  });

  it("n'autorise pas le passage de main sans clé Claude", async () => {
    const { gemini } = fakes([{ answer: "Je réponds moi-même" }]);
    const conversation = new Conversation(gemini, () => null);
    expect(await conversation.send("Question difficile", makeUi(), signal)).toBe("Je réponds moi-même");
    expect(gemini.send.mock.calls[0][3]).toBe(false);
  });

  it("va directement à Claude quand l'utilisateur force l'expert", async () => {
    const { gemini, claude } = fakes([]);
    const conversation = new Conversation(gemini, () => claude);
    await conversation.send("!explique la relativité", makeUi(), signal);
    expect(gemini.send).not.toHaveBeenCalled();
    expect((claude.send.mock.calls[0] as unknown as string[])[0]).toBe("explique la relativité");
  });

  it("refuse de forcer l'expert sans clé Claude", async () => {
    const { gemini } = fakes([]);
    const conversation = new Conversation(gemini, () => null);
    await expect(conversation.send("!explique", makeUi(), signal)).rejects.toThrow("/clé-claude");
  });

  it("revient à Gemini si Claude échoue au moment du passage de main", async () => {
    const { gemini, claude } = fakes([{ handoff: "x" }, { answer: "Gemini" }]);
    claude.send.mockRejectedValueOnce(new Error("Clé Claude refusée."));
    const conversation = new Conversation(gemini, () => claude);
    await expect(conversation.send("Question difficile", makeUi(), signal)).rejects.toThrow("Clé Claude refusée.");
    expect(conversation.expert).toBe(false);
    expect(await conversation.send("Autre chose", makeUi(), signal)).toBe("Gemini");
  });
});

describe("forcedExpert", () => {
  it("reconnaît les préfixes et les retire", () => {
    expect(forcedExpert("!explique")).toBe("explique");
    expect(forcedExpert("mode expert, explique")).toBe("explique");
    expect(forcedExpert("Réfléchis bien : comment faire ?")).toBe("comment faire ?");
  });

  it("laisse passer les messages normaux", () => {
    expect(forcedExpert("ouvre spotify")).toBeNull();
    expect(forcedExpert("le mode expert de Photoshop")).toBeNull();
  });
});
