// Aides communes aux outils : choisir parmi des propositions, protéger ce que Claude Code peut lire ou faire.

import type { OpenCandidate, OpenResolution } from "../native";
import type { ToolContext, ToolResult } from "./types";

export const NONE_OF_THESE = "Aucun de ceux-là";

export const isResult = (x: OpenCandidate | ToolResult): x is ToolResult => "ok" in x;

/** La cible trouvée, ou celle que l'utilisateur choisit en cas de doute ; sinon un échec à renvoyer tel quel. */
export async function pick(
  found: OpenResolution,
  ctx: ToolContext,
  question: string,
  name: string,
): Promise<OpenCandidate | ToolResult> {
  if (found.kind === "open") return found.candidates;
  if (found.kind === "nothing") return { ok: false, message: `Rien ne correspond à « ${name} »` };
  const labels = found.candidates.map((c) => `${c.label} (${c.detail})`);
  const choice = await ctx.ui.ask(question, [...labels, NONE_OF_THESE], false);
  if (choice === null) return { ok: false, message: "Annulé", data: { cancelled: true } };
  // « Aucun de ceux-là » : pas un refus, l'IA peut chercher autrement.
  return found.candidates[labels.indexOf(choice)] ?? { ok: false, message: `Aucune des propositions ne correspond à « ${name} »` };
}

/**
 * Claude Code lit des pages web qui peuvent contenir des consignes piégées : avant qu'il lise l'écran,
 * le presse-papiers ou agisse sur le PC, l'utilisateur donne son accord. Les autres origines passent.
 */
export async function claudeAllowed(ctx: ToolContext, message: string): Promise<boolean> {
  if (ctx.origin !== "claude") return true;
  return (await ctx.ui.permission(message, false)) !== "deny";
}

export const REFUSED: ToolResult = { ok: false, message: "Refusé par l'utilisateur" };
