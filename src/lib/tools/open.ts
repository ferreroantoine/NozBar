// « Ouvre X » : application ou fichier, sans jamais deviner quand plusieurs cibles se ressemblent.

import { native, type OpenCandidate } from "../native";
import { openPath } from "./files";
import { str, type Tool, type ToolContext, type ToolResult } from "./types";

export const NONE_OF_THESE = "Aucun de ceux-là";

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
    if (found.kind === "nothing") return { ok: false, message: `Rien ne correspond à « ${name} »` };

    const labels = found.candidates.map((c) => `${c.label} (${c.detail})`);
    const pick = await ctx.ui.ask("Tu veux ouvrir lequel ?", [...labels, NONE_OF_THESE], false);
    if (pick === null) return { ok: false, message: "Ouverture annulée", data: { cancelled: true } };
    const chosen = found.candidates[labels.indexOf(pick)];
    // « Aucun de ceux-là » : pas un refus, l'IA peut chercher autrement.
    if (!chosen) return { ok: false, message: `Aucune des propositions ne correspond à « ${name} »` };
    return openCandidate(chosen, ctx);
  },
};
