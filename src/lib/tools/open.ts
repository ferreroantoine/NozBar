// « Ouvre X » : application ou fichier, sans jamais deviner quand plusieurs cibles se ressemblent.

import { native, type OpenCandidate } from "../native";
import { openPath } from "./files";
import { isResult, NONE_OF_THESE, pick } from "./shared";
import { str, type Tool, type ToolContext, type ToolResult } from "./types";

export { NONE_OF_THESE };

async function openCandidate(c: OpenCandidate, ctx: ToolContext): Promise<ToolResult> {
  if (c.kind === "file") return openPath(c.target, ctx);
  await native.launchApp(c.target);
  return { ok: true, message: `${c.label} est ouvert`, data: { app: c.label } };
}

export const OPEN_TOOL: Tool = {
  name: "open_app",
  launches: true,
  description:
    "Ouvre une application installée ou un fichier (Téléchargements, Bureau, Documents) à partir de son nom. " +
    "En cas de doute entre plusieurs cibles, l'utilisateur choisit lui-même dans la bulle.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "Nom de l'application ou du fichier, ex. « Spotify »" } },
    required: ["name"],
  },
  status: (a) => `Ouverture de ${str(a.name) || "l'application"}…`,
  async run(a, ctx) {
    const name = str(a.name);
    const found = await native.resolveOpen(name);
    if (found.kind === "open") return openCandidate(found.candidates, ctx);
    // Les jeux Steam n'ont pas toujours de raccourci dans le menu Démarrer.
    if (found.kind === "nothing") {
      const game = await native.resolveGame(name).catch(() => ({ kind: "nothing" }) as const);
      if (game.kind !== "nothing") return GAME_TOOL.run(a, ctx);
      return { ok: false, message: `Rien ne correspond à « ${name} »` };
    }

    const labels = found.candidates.map((c) => `${c.label} (${c.detail})`);
    const pick = await ctx.ui.ask("Tu veux ouvrir lequel ?", [...labels, NONE_OF_THESE], false);
    if (pick === null) return { ok: false, message: "Ouverture annulée", data: { cancelled: true } };
    const chosen = found.candidates[labels.indexOf(pick)];
    // « Aucun de ceux-là » : pas un refus, l'IA peut chercher autrement.
    if (!chosen) return { ok: false, message: `Aucune des propositions ne correspond à « ${name} »` };
    return openCandidate(chosen, ctx);
  },
};

export const GAME_TOOL: Tool = {
  name: "launch_game",
  launches: true,
  description: "Lance un jeu Steam installé à partir de son nom (ex. « Rocket League »).",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "Nom du jeu" } },
    required: ["name"],
  },
  status: (a) => `Lancement de ${str(a.name) || "du jeu"}…`,
  async run(a, ctx) {
    const name = str(a.name);
    const game = await pick(await native.resolveGame(name), ctx, "Tu veux lancer lequel ?", name);
    if (isResult(game)) return game;
    await native.launchGame(game.target);
    return { ok: true, message: `${game.label} se lance`, data: { game: game.label } };
  },
};
