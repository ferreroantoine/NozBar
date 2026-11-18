// Onglets du navigateur : lister, aller sur un onglet, le fermer, lire la page affichée.

import { native } from "../native";
import { claudeAllowed, isResult, pick, REFUSED } from "./shared";
import { str, type Tool } from "./types";

/** Au-delà, la liste d'onglets n'aide plus l'IA. */
const MAX_LISTED_TABS = 40;

/** Navigateur par défaut de Windows, lu au démarrage pour les consignes de l'IA. */
export let defaultBrowser: string | null = null;

export async function loadDefaultBrowser() {
  defaultBrowser = await native.defaultBrowser().catch(() => null);
}

export const CLOSE_TAB_TOOL: Tool = {
  name: "close_tab",
  description:
    "Ferme un onglet du navigateur (Brave, Chrome, Edge, Firefox…) d'après son titre, ex. « YouTube ». " +
    "À utiliser pour une page ou un site, plutôt que close_app qui fermerait tout le navigateur.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "Titre ou site de l'onglet, ex. « YouTube »" } },
    required: ["name"],
  },
  status: (a) => `Fermeture de l'onglet ${str(a.name)}…`,
  async run(a, ctx) {
    const name = str(a.name);
    const tab = await pick(await native.resolveTab(name), ctx, "Quel onglet dois-je fermer ?", name);
    if (isResult(tab)) return tab;
    if (!(await claudeAllowed(ctx, `Claude veut fermer l'onglet ${tab.label}`))) return REFUSED;
    await native.closeTab(tab.target);
    return { ok: true, message: `Onglet « ${tab.label} » fermé` };
  },
};

export const BROWSER_TOOLS: Tool[] = [
  {
    name: "list_tabs",
    description: "Liste les onglets ouverts dans les navigateurs (titre, navigateur, onglet affiché).",
    parameters: { type: "object", properties: {} },
    status: () => "Lecture des onglets…",
    async run() {
      const tabs = await native.listTabs();
      if (!tabs.length) return { ok: true, message: "Aucun onglet ouvert", data: { tabs: [] } };
      const list = tabs.slice(0, MAX_LISTED_TABS).map((t) => `${t.label} (${t.detail})`);
      return { ok: true, message: `${tabs.length} onglets ouverts`, data: { tabs: list } };
    },
  },

  {
    name: "switch_tab",
    launches: true,
    description: "Affiche un onglet du navigateur d'après son titre (« va sur mon onglet Gmail »).",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Titre ou site de l'onglet" } },
      required: ["name"],
    },
    status: (a) => `Passage à l'onglet ${str(a.name)}…`,
    async run(a, ctx) {
      const name = str(a.name);
      const tab = await pick(await native.resolveTab(name), ctx, "Quel onglet veux-tu afficher ?", name);
      if (isResult(tab)) return tab;
      await native.switchTab(tab.target);
      return { ok: true, message: `Voici « ${tab.label} »` };
    },
  },

  CLOSE_TAB_TOOL,

  {
    name: "read_page",
    description:
      "Lit la page web affichée dans le navigateur (titre, adresse, texte) pour la résumer, l'expliquer ou " +
      "répondre à une question à son sujet (« résume cette page », « c'est quoi ce site ? »).",
    parameters: { type: "object", properties: {} },
    status: () => "Lecture de la page…",
    async run(_a, ctx) {
      if (!(await claudeAllowed(ctx, "Claude veut lire la page affichée dans ton navigateur"))) return REFUSED;
      const page = await native.readPage();
      if (!page.text) {
        return {
          ok: true,
          message: `Je vois « ${page.title} » mais je n'arrive pas à lire son texte`,
          data: { title: page.title, url: page.url },
        };
      }
      return { ok: true, message: `Page « ${page.title} » lue`, data: { ...page } };
    },
  },
];
