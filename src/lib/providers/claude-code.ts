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

const abortError = () => new DOMException("Annulé", "AbortError") as unknown as Error;

function friendlyError(text: string): Error {
  if (/log ?in|authenticat/i.test(text)) {
    return new Error("Claude Code n'est pas connecté : ouvrez un terminal, lancez `claude` et connectez-vous.");
  }
  if (/limit/i.test(text)) {
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
    let result: { text: string; sessionId?: string; isError: boolean } | null = null;
    let sessionId: string | undefined;

    const onAbort = () => void this.cancel();
    signal.addEventListener("abort", onAbort, { once: true });
    this.active = { ui, signal };
    try {
      await this.run(prompt, this.model, this.sessionId, (line) => {
        if (signal.aborted) return;
        for (const item of parseLine(line)) {
          if (item.kind === "session") sessionId = item.sessionId;
          else if (item.kind === "messageStart" && answer) {
            answer += "\n\n";
            ui.text("\n\n");
          } else if (item.kind === "text") {
            answer += item.text;
            ui.text(item.text);
          } else if (item.kind === "tool") ui.status(toolActivity(item.name, item.input));
          else if (item.kind === "result") result = item;
        }
      });
    } catch (e) {
      if (signal.aborted) throw abortError();
      // Un échec pendant le tour arrive d'abord comme résultat : il est plus parlant que le code de sortie.
      if (!result) throw friendlyError(e instanceof Error ? e.message : String(e));
    } finally {
      this.active = null;
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) throw abortError();
    const final = result as { text: string; sessionId?: string; isError: boolean } | null;
    if (!final) throw friendlyError("");
    if (final.isError) throw friendlyError(final.text);
    this.sessionId = final.sessionId ?? sessionId ?? this.sessionId;
    return answer || final.text;
  }
}
