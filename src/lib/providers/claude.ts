// Pilote Claude Sonnet : l'expert qui reprend les demandes complexes, avec les mêmes outils que Gemini.

import Anthropic from "@anthropic-ai/sdk";
import { memoryPrompt } from "../settings";
import { claudeTools, executeTool, type ToolContext, type Ui } from "../tools";

export const CLAUDE_MODEL = "claude-sonnet-5-5";
const MAX_STEPS = 8;
const MAX_TOKENS = 16_000;
/** Claude a sa propre recherche web : notre web_search (Google via Gemini) ferait doublon. */
const EXCLUDED_TOOLS = ["web_search", "ask_expert"];
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function systemPrompt(): string {
  const now = new Date().toLocaleString("fr-FR", { dateStyle: "full", timeStyle: "short" });
  return [
    "Tu es NozBar, un assistant intégré à Windows. On te confie les demandes qui demandent de la réflexion.",
    "Réponds en français, en markdown léger. Va droit au but : quelques phrases ou une courte liste d'étapes, sauf si on te demande plus.",
    "Utilise les outils pour agir sur l'ordinateur plutôt que d'expliquer comment faire.",
    "Si la demande est ambiguë, pose la question avec ask_user.",
    `Date et heure actuelles : ${now}.`,
    memoryPrompt(),
  ]
    .filter(Boolean)
    .join("\n");
}

function friendlyError(e: unknown): Error {
  if (e instanceof Anthropic.APIUserAbortError) return new DOMException("Annulé", "AbortError") as unknown as Error;
  if (e instanceof Anthropic.AuthenticationError) return new Error("Clé Claude refusée. Tapez /clé-claude pour la changer.");
  if (e instanceof Anthropic.RateLimitError) return new Error("Quota Claude atteint. Réessayez dans une minute.");
  if (e instanceof Anthropic.APIConnectionError) return new Error("Claude ne répond pas. Vérifiez votre connexion, puis réessayez.");
  if (e instanceof Anthropic.APIError && (e.status ?? 0) >= 500) {
    return new Error("Claude est saturé pour le moment. Réessayez dans quelques instants.");
  }
  return e instanceof Error ? e : new Error(String(e));
}

export class ClaudeProvider {
  private client: Anthropic;
  private history: Anthropic.Beta.BetaMessageParam[] = [];
  readonly label = "Sonnet";

  constructor(apiKey: string, client?: Anthropic) {
    // App de bureau locale : la clé vient du Gestionnaire d'identification, il n'y a pas de serveur où la cacher.
    this.client = client ?? new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 60_000 });
  }

  reset() {
    this.history = [];
  }

  /**
   * Envoie un message et diffuse la réponse ; renvoie le texte final.
   * `context` (l'échange déjà mené par Gemini) n'est ajouté qu'au premier message.
   */
  async send(text: string, ui: Ui, signal: AbortSignal, context?: string): Promise<string> {
    const start = this.history.length;
    const content =
      context && !start ? `Échange précédent avec l'assistant rapide :\n${context}\n\nDemande actuelle : ${text}` : text;
    this.history.push({ role: "user", content });
    try {
      return await this.turn(ui, signal);
    } catch (e) {
      // Un tour inachevé laisserait l'historique incohérent (tool_use sans tool_result…).
      this.history.length = start;
      throw friendlyError(e);
    }
  }

  private async turn(ui: Ui, signal: AbortSignal): Promise<string> {
    const ctx: ToolContext = {
      ui,
      signal,
      search: () => Promise.reject(new Error("Recherche indisponible")),
    };
    let answer = "";

    for (let step = 0; step < MAX_STEPS; step++) {
      const stream = this.client.beta.messages.stream(
        {
          model: CLAUDE_MODEL,
          max_tokens: MAX_TOKENS,
          system: systemPrompt(),
          messages: [...this.history],
          tools: [...claudeTools(EXCLUDED_TOOLS), { type: "web_search_20260209", name: "web_search", max_uses: 3 }],
          output_config: { effort: "medium" },
          betas: [FALLBACK_BETA],
          fallbacks: "default",
        },
        { signal },
      );
      stream.on("text", (delta) => {
        answer += delta;
        ui.text(delta);
      });
      const message = await stream.finalMessage();
      // Le contenu complet (réflexion comprise) doit être renvoyé tel quel au tour suivant.
      this.history.push({ role: "assistant", content: message.content });

      if (message.stop_reason === "refusal") throw new Error("Claude a refusé cette demande.");
      if (message.stop_reason === "pause_turn") continue;
      if (message.stop_reason !== "tool_use") {
        // Réponse coupée (max_tokens…) au milieu d'un appel : sans tool_result, l'API refuserait la suite.
        const dangling = message.content.filter((b) => b.type === "tool_use");
        if (dangling.length) {
          this.history.push({
            role: "user",
            content: dangling.map((b) => ({
              type: "tool_result" as const,
              tool_use_id: b.id,
              content: "Réponse interrompue avant l'exécution",
              is_error: true,
            })),
          });
        }
        return answer;
      }

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const block of message.content) {
        if (block.type !== "tool_use") continue;
        const input = block.input;
        if (!input || typeof input !== "object") {
          results.push({ type: "tool_result", tool_use_id: block.id, content: "Paramètres illisibles", is_error: true });
          continue;
        }
        const result = await executeTool(block.name, input as Record<string, unknown>, ctx);
        if (signal.aborted) throw new DOMException("Annulé", "AbortError");
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result.ok ? { message: result.message, ...result.data } : { error: result.message }),
          is_error: !result.ok,
        });
      }
      this.history.push({ role: "user", content: results });
    }
    throw new Error("Trop d'étapes pour cette demande");
  }
}
