// Types partagés par les outils, les pilotes d'IA et l'interface.

export interface Source {
  url: string;
  title: string;
  domain: string;
}

/** Retours vers l'interface pendant un tour. */
export interface Ui {
  status(text: string): void;
  text(delta: string): void;
  sources(list: Source[]): void;
  /** Demande une validation (Entrée / Échap) ; `action` est le libellé du bouton de validation. */
  confirm(message: string, action: string): Promise<boolean>;
  /**
   * Demande d'autorisation : « Autoriser » (once), « Toujours autoriser » (always, proposé seulement si
   * `remember`) ou « Refuser » (deny). Échap ou bulle fermée valent un refus.
   */
  permission(message: string, remember: boolean): Promise<"once" | "always" | "deny">;
  /** Un outil vient d'ouvrir une fenêtre : la bulle peut reprendre le focus qu'elle va perdre. */
  launched?(): void;
  /** Pose une question à choix ; `null` si l'utilisateur annule. */
  ask(question: string, choices: string[], allowText: boolean): Promise<string | null>;
  /** L'expert (Claude) prend la main jusqu'à la fermeture de la bulle ; `label` s'affiche sur le badge. */
  expert(label: string): void;
}

export interface ToolContext {
  ui: Ui;
  signal: AbortSignal;
  /** « claude » : appel venu de Claude Code par le pont MCP (règles plus strictes). */
  origin?: "user" | "claude";
  search(query: string): Promise<{ summary: string; sources: Source[] }>;
}

export type Args = Record<string, unknown>;

export interface ToolResult {
  ok: boolean;
  /** Phrase courte en français, affichée telle quelle pour les commandes locales. */
  message: string;
  data?: Record<string, unknown>;
}

/** Schéma JSON d'un objet de paramètres, compris à la fois par Gemini et par Claude. */
export type JsonSchema = Record<string, unknown>;

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  status(args: Args): string;
  run(args: Args, ctx: ToolContext): Promise<ToolResult>;
  /** L'outil ouvre une fenêtre (application, page, fichier). */
  launches?: boolean;
}

export const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
export const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined);

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  if (s || !parts.length) parts.push(`${s} s`);
  return parts.join(" ");
}

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
