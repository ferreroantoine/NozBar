// « Ferme X » : ferme proprement une application ouverte, comme un clic sur la croix.

import { native } from "../native";
import { NONE_OF_THESE } from "./open";
import { str, type Tool } from "./types";

export const CLOSE_TOOL: Tool = {
  name: "close_app",
  description:
    "Ferme proprement une application ouverte (toutes ses fenêtres), comme un clic sur la croix : elle peut " +
    "proposer d'enregistrer. À utiliser plutôt qu'une commande système. En cas de doute, l'utilisateur choisit.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "Nom de l'application, ex. « Chrome »" } },
    required: ["name"],
  },
  status: (a) => `Fermeture de ${str(a.name) || "l'application"}…`,
  async run(a, ctx) {
    const name = str(a.name);
    const found = await native.resolveClose(name);
    if (found.kind === "nothing") return { ok: false, message: `Aucune application ouverte ne correspond à « ${name} »` };

    let target = found.kind === "open" ? found.candidates : null;
    if (found.kind === "choose") {
      const labels = found.candidates.map((c) => `${c.label} (${c.detail})`);
      const pick = await ctx.ui.ask("Tu veux fermer laquelle ?", [...labels, NONE_OF_THESE], false);
      if (pick === null) return { ok: false, message: "Fermeture annulée", data: { cancelled: true } };
      target = found.candidates[labels.indexOf(pick)] ?? null;
      if (!target) return { ok: false, message: `Aucune des propositions ne correspond à « ${name} »` };
    }
    // Fermer peut faire perdre un travail en cours (console, terminal) : Claude demande d'abord.
    if (ctx.origin === "claude") {
      const answer = await ctx.ui.permission(`Claude veut fermer ${target!.label} (${target!.detail})`, false);
      if (answer === "deny") return { ok: false, message: "Fermeture refusée par l'utilisateur" };
    }
    await native.closeApp(target!.target);
    return { ok: true, message: `${target!.label} est fermé` };
  },
};
