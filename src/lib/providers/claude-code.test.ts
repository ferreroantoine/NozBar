import { describe, expect, it, vi } from "vitest";
import type { Ui } from "../tools";
import { ClaudeCodeProvider, type RunClaudeCode } from "./claude-code";

const SID = "sess-1";
const line = (o: unknown) => JSON.stringify(o);
const text = (t: string) =>
  line({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: t } } });
const start = line({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: {} } });
const result = (r: string, isError = false) => line({ type: "result", subtype: "success", is_error: isError, result: r, session_id: SID });

function makeUi() {
  return {
    status: vi.fn(),
    text: vi.fn(),
    sources: vi.fn(),
    confirm: async () => true,
    ask: async () => null,
    expert: vi.fn(),
  } satisfies Ui;
}

/** Faux lancement : rejoue des lignes de flux, en mémorisant les arguments. */
function fakeRun(...turns: string[][]) {
  return vi.fn<RunClaudeCode>(async (_prompt, _model, _resume, onLine) => {
    for (const l of turns.shift() ?? []) onLine(l);
  });
}

const signal = () => new AbortController().signal;

describe("ClaudeCodeProvider", () => {
  it("diffuse le texte et renvoie la réponse", async () => {
    const run = fakeRun([start, text("Bon"), text("jour"), result("Bonjour")]);
    const ui = makeUi();
    const answer = await new ClaudeCodeProvider(run, vi.fn()).send("Salut", ui, signal());
    expect(answer).toBe("Bonjour");
    expect(ui.text.mock.calls.map((c) => c[0])).toEqual(["Bon", "jour"]);
    expect(run.mock.calls[0][1]).toBe("sonnet");
    expect(run.mock.calls[0][2]).toBeNull();
  });

  it("sépare les messages successifs d'un même tour et affiche les outils", async () => {
    const tool = line({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "x" } }] },
    });
    const run = fakeRun([start, text("Je cherche."), tool, start, text("Trouvé."), result("Trouvé.")]);
    const ui = makeUi();
    const answer = await new ClaudeCodeProvider(run, vi.fn()).send("?", ui, signal());
    expect(answer).toBe("Je cherche.\n\nTrouvé.");
    expect(ui.status).toHaveBeenCalledWith("Recherche : x…");
  });

  it("reprend la session de la bulle au message suivant, et l'oublie au reset", async () => {
    const run = fakeRun([result("Un")], [result("Deux")], [result("Trois")]);
    const claude = new ClaudeCodeProvider(run, vi.fn());
    await claude.send("A", makeUi(), signal(), "Utilisateur : bonjour");
    await claude.send("B", makeUi(), signal());
    claude.reset();
    await claude.send("C", makeUi(), signal());
    expect(run.mock.calls[0][0]).toContain("Utilisateur : bonjour");
    expect(run.mock.calls[0][0]).toContain("A");
    expect(run.mock.calls[1][0]).toBe("B");
    expect(run.mock.calls.map((c) => c[2])).toEqual([null, SID, null]);
  });

  it("traduit les erreurs de connexion et de limite", async () => {
    const notLogged = new ClaudeCodeProvider(fakeRun([result("Not logged in · Please run /login", true)]), vi.fn());
    await expect(notLogged.send("x", makeUi(), signal())).rejects.toThrow("lancez `claude`");
    const limit = new ClaudeCodeProvider(fakeRun([result("Claude usage limit reached", true)]), vi.fn());
    await expect(limit.send("x", makeUi(), signal())).rejects.toThrow("Limite de votre abonnement");
  });

  it("expose le tour actif au pont MCP pendant le travail seulement", async () => {
    let seen: unknown = undefined;
    const claude: ClaudeCodeProvider = new ClaudeCodeProvider(
      vi.fn<RunClaudeCode>(async (_p, _m, _r, onLine) => {
        seen = claude.active;
        onLine(result("ok"));
      }),
      vi.fn(),
    );
    const ui = makeUi();
    await claude.send("x", ui, signal());
    expect(seen).toMatchObject({ ui });
    expect(claude.active).toBeNull();
  });

  it("arrête Claude Code quand le tour est annulé", async () => {
    const ctrl = new AbortController();
    const cancel = vi.fn();
    const run = vi.fn<RunClaudeCode>(async () => {
      ctrl.abort();
      throw new Error("Claude Code s'est arrêté");
    });
    await expect(new ClaudeCodeProvider(run, cancel).send("x", makeUi(), ctrl.signal)).rejects.toThrow("Annulé");
    expect(cancel).toHaveBeenCalled();
  });

  it("un tour annulé qui se termine en retard n'efface pas le tour suivant", async () => {
    let finishOld: () => void = () => {};
    const run = vi.fn<RunClaudeCode>()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finishOld = resolve)))
      .mockImplementationOnce(async (_p, _m, _r, onLine) => {
        finishOld(); // l'ancien tour se termine pendant le nouveau
        await Promise.resolve();
        expect(claude.active?.ui).toBe(newUi);
        onLine(result("ok"));
      });
    const claude: ClaudeCodeProvider = new ClaudeCodeProvider(run, vi.fn());
    const oldCtrl = new AbortController();
    const old = claude.send("A", makeUi(), oldCtrl.signal).catch(() => {});
    oldCtrl.abort();
    const newUi = makeUi();
    await claude.send("B", newUi, signal());
    await old;
  });

  it("garde la session dès son ouverture, même si le tour est annulé", async () => {
    const ctrl = new AbortController();
    const run = vi.fn<RunClaudeCode>()
      .mockImplementationOnce(async (_p, _m, _r, onLine) => {
        onLine(line({ type: "system", subtype: "init", session_id: SID }));
        ctrl.abort();
      })
      .mockImplementationOnce(async (_p, _m, _r, onLine) => onLine(result("ok")));
    const claude = new ClaudeCodeProvider(run, vi.fn());
    await expect(claude.send("A", makeUi(), ctrl.signal)).rejects.toThrow("Annulé");
    await claude.send("B", makeUi(), signal());
    expect(run.mock.calls[1][2]).toBe(SID);
  });

  it("attend le résultat s'il arrive juste après la fin de la commande", async () => {
    const run = vi.fn<RunClaudeCode>(async (_p, _m, _r, onLine) => {
      setTimeout(() => onLine(result("tardif")), 20);
    });
    expect(await new ClaudeCodeProvider(run, vi.fn()).send("x", makeUi(), signal())).toBe("tardif");
  });

  it("ne confond pas une limite de contexte avec la limite d'abonnement", async () => {
    const ctx = new ClaudeCodeProvider(fakeRun([result("Prompt is too long: context limit exceeded", true)]), vi.fn());
    await expect(ctx.send("x", makeUi(), signal())).rejects.toThrow("Claude Code : Prompt is too long");
  });

  it("utilise Opus quand on le demande, jusqu'au reset", async () => {
    const run = fakeRun([result("a")], [result("b")]);
    const claude = new ClaudeCodeProvider(run, vi.fn());
    claude.model = "opus";
    await claude.send("x", makeUi(), signal());
    claude.reset();
    await claude.send("y", makeUi(), signal());
    expect(run.mock.calls.map((c) => c[1])).toEqual(["opus", "sonnet"]);
  });
});
