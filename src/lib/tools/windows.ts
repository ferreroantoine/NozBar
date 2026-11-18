// Fenêtres : mettre une application au premier plan, la réduire, l'agrandir, l'ancrer, la changer d'écran.

import { native, type WindowAction } from "../native";
import { isResult, pick } from "./shared";
import { str, type Tool } from "./types";

const ACTIONS: Record<WindowAction, { status: string; done: (app: string) => string }> = {
  focus: { status: "Affichage de", done: (app) => `Voici ${app}` },
  minimize: { status: "Réduction de", done: (app) => `${app} est réduit` },
  maximize: { status: "Agrandissement de", done: (app) => `${app} est en plein écran` },
  restore: { status: "Restauration de", done: (app) => `${app} est restauré` },
  left: { status: "Ancrage à gauche de", done: (app) => `${app} est à gauche` },
  right: { status: "Ancrage à droite de", done: (app) => `${app} est à droite` },
  next_screen: { status: "Déplacement de", done: (app) => `${app} est sur l'autre écran` },
};

const isAction = (a: string): a is WindowAction => a in ACTIONS;

export const WINDOW_TOOLS: Tool[] = [
  {
    name: "manage_window",
    launches: true,
    description:
      "Agit sur la fenêtre d'une application ouverte : focus (la montrer au premier plan), minimize, maximize, " +
      "restore, left / right (moitié gauche ou droite de l'écran), next_screen (passer sur l'autre écran). " +
      "« Mets Brave à gauche et Discord à droite » : deux appels.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nom de l'application, ex. « Discord »" },
        action: { type: "string", enum: Object.keys(ACTIONS) },
      },
      required: ["name", "action"],
    },
    status: (a) => `${ACTIONS[str(a.action) as WindowAction]?.status ?? "Fenêtre de"} ${str(a.name)}…`,
    async run(a, ctx) {
      const name = str(a.name);
      const action = str(a.action);
      if (!isAction(action)) return { ok: false, message: `Action inconnue : ${action}` };
      const app = await pick(await native.resolveClose(name), ctx, "Quelle fenêtre ?", name);
      if (isResult(app)) return app;
      await native.windowAction(app.target, action);
      return { ok: true, message: ACTIONS[action].done(app.label) };
    },
  },

  {
    name: "show_desktop",
    description: "Réduit toutes les fenêtres pour montrer le bureau (un second appel les remet).",
    parameters: { type: "object", properties: {} },
    status: () => "Affichage du bureau…",
    async run() {
      await native.showDesktop();
      return { ok: true, message: "Voici le bureau" };
    },
  },
];
