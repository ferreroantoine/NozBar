// Pilote Claude Code : l'expert passe par l'abonnement Claude de l'utilisateur (binaire officiel `claude -p`).

import { native } from "../native";
import type { Ui } from "../tools";
import { parseLine, toolActivity } from "./claude-code-stream";

export type ClaudeCodeModel = "sonnet" | "opus";
export type RunClaudeCode = (
  prompt: string,
  model: ClaudeCodeModel,
  resume: string | null,
  onLine: (line: string) => void,
) => Promise<void>;

type Result = { text: string; sessionId?: string; isError: boolean };

/** La dernière ligne du flux peut arriver juste après la réponse de la commande. */
const LATE_RESULT_MS = 1000;

const abortError = () => new DOMException("Annulé", "AbortError") as unknown as Error;

function friendlyError(text: string): Error {
  if (/not logged in|log ?in|authenticat/i.test(text)) {
    return new Error("Claude Code n'est pas connecté : ouvrez un terminal, lancez `claude` et connectez-vous.");
  }
  if (/usage limit|rate limit|limit reached|quota/i.test(text)) {
    return new Error("Limite de votre abonnement Claude atteinte. Réessayez plus tard.");
  }
  return new Error(text ? `Claude Code : ${text}` : "Claude Code n'a pas répondu.");
}

export class ClaudeCodeProvider {
  /** Sonnet par défaut ; la Conversation passe à Opus sur demande, jusqu'au reset. */
  model: ClaudeCodeModel = "sonnet";
  /** Tour en cours : le pont MCP y exécute les outils NozBar que Claude Code appelle. */
  active: { ui: Ui; signal: AbortSignal } | null = null;
  private sessionId: string | null = null;

  get label() {
    return this.model === "opus" ? "Opus" : "Sonnet";
  }

  constructor(
    private run: RunClaudeCode = native.claudeCodeSend,
    private cancel: () => unknown = native.claudeCodeCancel,
  ) {}

  reset() {
    this.sessionId = null;
    this.model = "sonnet";
  }

  /** `context` (l'échange déjà mené par Gemini) n'accompagne que le premier message de la session. */
  async send(text: string, ui: Ui, signal: AbortSignal, context?: string): Promise<string> {
    const prompt =
      context && !this.sessionId ? `Échange précédent avec l'assistant rapide :\n${context}\n\nDemande actuelle : ${text}` : text;
    let answer = "";
    let result: Result | null = null;
    let onResult: () => void = () => {};
    const resultSeen = new Promise<void>((resolve) => (onResult = resolve));

    const onAbort = () => void this.cancel();
    signal.addEventListener("abort", onAbort, { once: true });
    const turn = { ui, signal };
    this.active = turn;
    let failure: unknown = null;
    try {
      await this.run(prompt, this.model, this.sessionId, (line) => {
        for (const item of parseLine(line)) {
          // La session est gardée dès son ouverture : un tour annulé ne doit pas perdre le fil de la bulle.
          if (item.kind === "session") this.sessionId = item.sessionId;
          else if (item.kind === "result") {
            result = item;
            onResult();
          } else if (signal.aborted) continue;
          else if (item.kind === "messageStart" && answer) {
            answer += "\n\n";
            ui.text("\n\n");
          } else if (item.kind === "text") {
            answer += item.text;
            ui.text(item.text);
          } else if (item.kind === "tool") ui.status(toolActivity(item.name, item.input));
        }
      });
      if (!result && !signal.aborted) await Promise.race([resultSeen, new Promise((r) => setTimeout(r, LATE_RESULT_MS))]);
    } catch (e) {
      failure = e;
    } finally {
      // Un ancien tour qui se termine en retard ne doit pas débrancher le tour suivant.
      if (this.active === turn) this.active = null;
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) throw abortError();
    const final = result as Result | null;
    // Un échec pendant le tour arrive d'abord comme résultat : il est plus parlant que le code de sortie.
    if (!final) throw friendlyError(failure ? (failure instanceof Error ? failure.message : String(failure)) : "");
    if (final.isError) throw friendlyError(final.text);
    this.sessionId = final.sessionId ?? this.sessionId;
    return answer || final.text;
  }
}
