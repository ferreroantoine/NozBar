// « Ferme X » : ferme proprement une application ouverte, comme un clic sur la croix.

import { native } from "../native";
import { CLOSE_TAB_TOOL } from "./browser";
import { NONE_OF_THESE } from "./shared";
import { str, type Tool } from "./types";

export const CLOSE_TOOL: Tool = {
  name: "close_app",
  description:
    "Ferme proprement une application ouverte (toutes ses fenêtres), comme un clic sur la croix : elle peut " +
    "proposer d'enregistrer. Si elle reste ensuite en arrière-plan (zone de notification), elle est arrêtée. " +
    "À utiliser plutôt qu'une commande système. En cas de doute, l'utilisateur choisit. " +
    "Pour une page ou un site ouvert dans le navigateur, utilise close_tab.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "Nom de l'application, ex. « Chrome »" } },
    required: ["name"],
  },
  status: (a) => `Fermeture de ${str(a.name) || "l'application"}…`,
  async run(a, ctx) {
    const name = str(a.name);
    const found = await native.resolveClose(name);
    if (found.kind === "nothing") {
      // « Ferme YouTube » : pas une application, mais peut-être un onglet.
      const tab = await native.resolveTab(name).catch(() => ({ kind: "nothing" }) as const);
      if (tab.kind !== "nothing") return CLOSE_TAB_TOOL.run(a, ctx);
      return { ok: false, message: `Aucune application ni aucun onglet ouvert ne correspond à « ${name} »` };
    }

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
    const { background } = await native.closeApp(target!.target);
    return {
      ok: true,
      message: background
        ? `${target!.label} est fermé (il tournait encore en arrière-plan, je l'ai arrêté)`
        : `${target!.label} est fermé`,
    };
  },
};
