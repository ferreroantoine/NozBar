import { describe, expect, it, vi } from "vitest";
import { Conversation, type ClaudeLike, type GeminiLike } from "./conversation";
import type { Ui } from "./tools";

function makeUi() {
  return {
    status: vi.fn(),
    text: vi.fn(),
    sources: vi.fn(),
    confirm: async () => true,
    permission: async () => "once" as const,
    ask: async () => null,
    expert: vi.fn<(label: string) => void>(),
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
  const claude = { send: vi.fn(async () => "Réponse de Sonnet"), reset: vi.fn(), label: "Sonnet" } satisfies ClaudeLike;
  return { gemini, claude };
}

describe("Conversation", () => {
  it("passe la main à Claude avec l'échange précédent quand Gemini le demande", async () => {
    const { gemini, claude } = fakes([{ answer: "Salut !" }, { handoff: "expliquer les masques de fusion", model: "sonnet" }]);
    const conversation = new Conversation(gemini, () => claude);
    const ui = makeUi();
    await conversation.send("Bonjour", ui, signal);
    const answer = await conversation.send("Comment faire un masque de fusion ?", ui, signal);

    expect(answer).toBe("Réponse de Sonnet");
    expect(ui.expert).toHaveBeenCalledExactlyOnceWith("Sonnet");
    expect(conversation.expert).toBe(true);
    const [text, , , context] = claude.send.mock.calls[0] as unknown as [string, Ui, AbortSignal, string];
    expect(text).toContain("Comment faire un masque de fusion ?");
    expect(text).toContain("expliquer les masques de fusion");
    expect(context).toBe("Utilisateur : Bonjour\nAssistant : Salut !");
  });

  it("garde Claude jusqu'au reset, puis revient à Gemini", async () => {
    const { gemini, claude } = fakes([{ handoff: "x", model: "sonnet" }, { answer: "Gemini" }]);
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

  it("un « ! » en tête de message n'a plus de sens particulier : Gemini décide", async () => {
    const { gemini, claude } = fakes([{ answer: "Réponse rapide" }]);
    const conversation = new Conversation(gemini, () => claude);
    expect(await conversation.send("!explique la relativité", makeUi(), signal)).toBe("Réponse rapide");
    expect(claude.send).not.toHaveBeenCalled();
  });

  it("passe sur Opus quand Gemini juge la tâche difficile, et l'affiche", async () => {
    const { gemini, claude } = fakes([{ handoff: "démontrer le théorème", model: "opus" as const }]);
    const opusCapable = { ...claude, model: "sonnet" as "sonnet" | "opus", get label(): string { return this.model === "opus" ? "Opus" : "Sonnet"; } };
    const conversation = new Conversation(gemini, () => opusCapable);
    const ui = makeUi();
    await conversation.send("Démontre le théorème de Fermat pour n = 4", ui, signal);
    expect(opusCapable.model).toBe("opus");
    expect(ui.expert).toHaveBeenCalledWith("Opus");
  });

  it("revient à Gemini si Claude échoue au moment du passage de main", async () => {
    const { gemini, claude } = fakes([{ handoff: "x", model: "sonnet" }, { answer: "Gemini" }]);
    claude.send.mockRejectedValueOnce(new Error("Clé Claude refusée."));
    const conversation = new Conversation(gemini, () => claude);
    await expect(conversation.send("Question difficile", makeUi(), signal)).rejects.toThrow("Clé Claude refusée.");
    expect(conversation.expert).toBe(false);
    expect(await conversation.send("Autre chose", makeUi(), signal)).toBe("Gemini");
  });
});
