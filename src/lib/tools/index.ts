// Catalogue d'outils : décrit une fois, traduit pour Gemini et pour Claude, exécuté localement.

import type Anthropic from "@anthropic-ai/sdk";
import type { FunctionDeclaration } from "@google/genai";
import { CLOSE_TOOL } from "./close";
import { DIALOG_TOOLS } from "./dialog";
import { EXPERT_TOOL } from "./expert";
import { FILE_TOOLS } from "./files";
import { OPEN_TOOL } from "./open";
import { SYSTEM_TOOLS } from "./system";
import { errorMessage, type Args, type Tool, type ToolContext, type ToolResult } from "./types";
import { WEATHER_TOOL } from "./weather";

export * from "./types";

export const TOOLS: Tool[] = [OPEN_TOOL, CLOSE_TOOL, ...SYSTEM_TOOLS, ...FILE_TOOLS, WEATHER_TOOL, ...DIALOG_TOOLS, EXPERT_TOOL];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Le texte gris reste affiché au moins ce temps, même si l'action est instantanée. */
const MIN_STATUS_MS = 400;

const included = (exclude: string[]) => TOOLS.filter((t) => !exclude.includes(t.name));

export function geminiDeclarations(exclude: string[] = []): FunctionDeclaration[] {
  return included(exclude).map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: t.parameters,
  }));
}

export function claudeTools(exclude: string[] = []): Anthropic.Beta.BetaTool[] {
  return included(exclude).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
    eager_input_streaming: true,
  }));
}

export function toolStatus(name: string, args: Args): string {
  return BY_NAME.get(name)?.status(args) ?? "Action en cours…";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// On laisse le navigateur peindre le texte gris avant de lancer l'action.
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

export async function executeTool(name: string, args: Args, ctx: ToolContext): Promise<ToolResult> {
  const tool = BY_NAME.get(name);
  if (!tool) return { ok: false, message: `Outil inconnu : ${name}` };

  const shownAt = performance.now();
  ctx.ui.status(tool.status(args));
  await nextPaint();
  // Bulle fermée ou nouveau message pendant l'attente : l'action ne doit plus avoir lieu.
  if (ctx.signal.aborted) throw new DOMException("Annulé", "AbortError");

  let result: ToolResult;
  try {
    result = await tool.run(args, ctx);
  } catch (e) {
    result = { ok: false, message: errorMessage(e) };
  }
  if (result.ok && tool.launches) ctx.ui.launched?.();
  const wait = MIN_STATUS_MS - (performance.now() - shownAt);
  if (wait > 0) await sleep(wait);
  return result;
}
