import { describe, expect, it, vi } from "vitest";
import { Pending } from "./pending";
import { DIALOG_TOOLS } from "./tools/dialog";
import type { ToolContext } from "./tools/types";

const request = { kind: "ask" as const, question: "Lequel ?", choices: ["A", "B"], allowText: false };

describe("Pending", () => {
  it("résout la réponse choisie puis se vide", async () => {
    const pending = new Pending();
    const answer = pending.open(request);
    expect(pending.current).toEqual(request);
    pending.answer("B");
    await expect(answer).resolves.toBe("B");
    expect(pending.current).toBeNull();
  });

  it("résout null quand on annule (Échap, fermeture de la bulle)", async () => {
    const pending = new Pending();
    const answer = pending.open(request);
    pending.cancel();
    await expect(answer).resolves.toBeNull();
    expect(pending.current).toBeNull();
  });

  it("annule la question précédente quand une nouvelle arrive", async () => {
    const pending = new Pending();
    const first = pending.open(request);
    const second = pending.open({ ...request, question: "Et maintenant ?" });
    await expect(first).resolves.toBeNull();
    pending.answer("A");
    await expect(second).resolves.toBe("A");
  });

  it("prévient l'interface à chaque changement", () => {
    const pending = new Pending();
    const onChange = vi.fn();
    pending.onChange = onChange;
    void pending.open(request);
    pending.cancel();
    expect(onChange.mock.calls).toEqual([[request], [null]]);
  });

  it("ignore une réponse sans question en cours", () => {
    const pending = new Pending();
    expect(() => pending.answer("A")).not.toThrow();
  });
});

describe("ask_user", () => {
  const askUser = DIALOG_TOOLS.find((t) => t.name === "ask_user")!;
  const ctxWith = (reply: string | null) =>
    ({ ui: { ask: vi.fn(async () => reply) } }) as unknown as ToolContext;

  it("renvoie le choix de l'utilisateur", async () => {
    const ctx = ctxWith("B");
    const result = await askUser.run({ question: "Lequel ?", choices: ["A", "B"] }, ctx);
    expect(ctx.ui.ask).toHaveBeenCalledWith("Lequel ?", ["A", "B"], false);
    expect(result).toMatchObject({ ok: true, data: { answer: "B" } });
  });

  it("signale l'absence de réponse", async () => {
    const result = await askUser.run({ question: "Lequel ?", choices: ["A", "B"] }, ctxWith(null));
    expect(result).toMatchObject({ ok: false, message: "L'utilisateur n'a pas répondu" });
  });

  it("refuse moins de 2 ou plus de 6 choix", async () => {
    const ctx = ctxWith("A");
    expect((await askUser.run({ question: "?", choices: ["A"] }, ctx)).ok).toBe(false);
    expect((await askUser.run({ question: "?", choices: ["1", "2", "3", "4", "5", "6", "7"] }, ctx)).ok).toBe(false);
    expect(ctx.ui.ask).not.toHaveBeenCalled();
  });
});
