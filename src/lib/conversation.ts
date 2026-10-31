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

  /** C'est Gemini qui décide seul de passer la main, et à quel modèle. */
  async send(text: string, ui: Ui, signal: AbortSignal): Promise<string> {
    const claude = this.claude();
    if (this.expert && claude) return claude.send(text, ui, signal);

    const reply = await this.gemini.send(text, ui, signal, claude !== null);
    if ("handoff" in reply && claude) return this.handOff(claude, text, reply.handoff, reply.model, ui, signal);
    const answer = "answer" in reply ? reply.answer : "";
    this.log.push({ user: text, assistant: answer });
    return answer;
  }

  private async handOff(
    claude: ClaudeLike,
    text: string,
    task: string,
    model: "sonnet" | "opus",
    ui: Ui,
    signal: AbortSignal,
  ): Promise<string> {
    if (claude.model) claude.model = model;
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
