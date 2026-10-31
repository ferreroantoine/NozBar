// Chef d'orchestre : Gemini Flash-Lite par défaut, Claude Sonnet après un passage de main, jusqu'au reset.

import type { GeminiReply } from "./providers/gemini";
import type { Source, Ui } from "./tools";

export interface GeminiLike {
  send(text: string, ui: Ui, signal: AbortSignal, canHandoff: boolean): Promise<GeminiReply>;
  reset(): void;
  search(query: string, signal: AbortSignal): Promise<{ summary: string; sources: Source[] }>;
  transcribe(wavBase64: string, signal: AbortSignal): Promise<string>;
}

export interface ClaudeLike {
  send(text: string, ui: Ui, signal: AbortSignal, context?: string): Promise<string>;
  reset(): void;
  /** Nom affiché sur le badge (« Sonnet », « Opus »). */
  readonly label: string;
  /** Présent si l'expert sait passer sur Opus (Claude Code). */
  model?: "sonnet" | "opus";
}

const NO_EXPERT =
  "Aucun expert disponible : lancez `claude` dans un terminal pour connecter Claude Code, ou tapez /clé-claude.";

/**
 * « !… », « mode expert, … », « réfléchis bien : … » envoient directement à l'expert ;
 * « !!… » et « réfléchis très bien : … » demandent en plus Opus.
 */
const FORCE_PREFIX = /^(?:(!!)\s*|!\s*|(r[ée]fl[ée]chis tr[eè]s bien)\b[\s,:.!-]*|(?:mode expert|r[ée]fl[ée]chis bien)\b[\s,:.!-]*)/i;

/** Texte nettoyé si l'utilisateur force l'expert, sinon `null`. */
export function forcedExpert(text: string): { text: string; opus: boolean } | null {
  const trimmed = text.trim();
  const match = FORCE_PREFIX.exec(trimmed);
  if (!match) return null;
  return { text: trimmed.slice(match[0].length).trim(), opus: Boolean(match[1] || match[2]) };
}

export class Conversation {
  /** Vrai dès que Sonnet a pris la main, jusqu'au prochain reset (fermeture de la bulle). */
  expert = false;
  /** Échanges menés par Gemini, transmis à Claude lors du passage de main. */
  private log: { user: string; assistant: string }[] = [];

  constructor(
    private gemini: GeminiLike,
    private claude: () => ClaudeLike | null,
  ) {}

  reset() {
    this.expert = false;
    this.log = [];
    this.gemini.reset();
    this.claude()?.reset();
  }

  search(query: string, signal: AbortSignal) {
    return this.gemini.search(query, signal);
  }

  transcribe(wavBase64: string, signal: AbortSignal) {
    return this.gemini.transcribe(wavBase64, signal);
  }

  async send(raw: string, ui: Ui, signal: AbortSignal): Promise<string> {
    const forced = forcedExpert(raw);
    const text = forced?.text ?? raw;
    const claude = this.claude();
    if (forced?.opus && claude?.model) claude.model = "opus";

    if (this.expert && claude) {
      if (forced?.opus) ui.expert(claude.label);
      return claude.send(text, ui, signal);
    }
    if (forced) return this.handOff(text, "", ui, signal);

    const reply = await this.gemini.send(text, ui, signal, claude !== null);
    if ("handoff" in reply) return this.handOff(text, reply.handoff, ui, signal);
    this.log.push({ user: text, assistant: reply.answer });
    return reply.answer;
  }

  private async handOff(text: string, task: string, ui: Ui, signal: AbortSignal): Promise<string> {
    const claude = this.claude();
    if (!claude) throw new Error(NO_EXPERT);
    ui.expert(claude.label);
    ui.status(`Je passe la main à ${claude.label}…`);
    this.expert = true;
    const request = task && task !== text ? `${text}\n\n(Tâche transmise par l'assistant rapide : ${task})` : text;
    const context = this.log.map((e) => `Utilisateur : ${e.user}\nAssistant : ${e.assistant}`).join("\n");
    try {
      return await claude.send(request, ui, signal, context || undefined);
    } catch (e) {
      // Clé refusée, quota… : on revient à Gemini plutôt que de bloquer la bulle sur un expert en panne.
      this.expert = false;
      claude.reset();
      throw e;
    }
  }
}
