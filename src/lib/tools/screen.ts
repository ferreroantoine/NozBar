// Ce que l'utilisateur a sous les yeux : texte sélectionné, presse-papiers, capture d'écran décrite par l'IA.

import { native } from "../native";
import { claudeAllowed, REFUSED } from "./shared";
import { str, type Tool } from "./types";

/** Au-delà, un texte copié noierait l'IA (et coûterait cher). */
const MAX_TEXT = 20_000;

type Vision = (jpegBase64: string, question: string, signal: AbortSignal) => Promise<string>;
let vision: Vision | null = null;

/** Branché sur Gemini dès que sa clé est connue : c'est lui qui regarde les captures. */
export function setVision(fn: Vision | null) {
  vision = fn;
}

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[…texte coupé]` : text);

export const SCREEN_TOOLS: Tool[] = [
  {
    name: "get_selection",
    description:
      "Récupère le texte que l'utilisateur a sélectionné dans la fenêtre qu'il regardait (« traduis ça », " +
      "« résume ce texte », « réponds à ce mail »). Si rien n'est sélectionné, essaie read_clipboard.",
    parameters: { type: "object", properties: {} },
    status: () => "Lecture de la sélection…",
    async run(_a, ctx) {
      if (!(await claudeAllowed(ctx, "Claude veut lire le texte que tu as sélectionné"))) return REFUSED;
      // La copie passe brièvement par la fenêtre d'origine : la bulle reprendra le focus ensuite.
      ctx.ui.launched?.();
      const text = await native.getSelection();
      return { ok: true, message: "Sélection récupérée", data: { text: clip(text) } };
    },
  },

  {
    name: "read_clipboard",
    description: "Lit le texte copié dans le presse-papiers (« ce que j'ai copié »).",
    parameters: { type: "object", properties: {} },
    status: () => "Lecture du presse-papiers…",
    async run(_a, ctx) {
      if (!(await claudeAllowed(ctx, "Claude veut lire ton presse-papiers"))) return REFUSED;
      const text = await native.readClipboard();
      return { ok: true, message: "Presse-papiers lu", data: { text: clip(text) } };
    },
  },

  {
    name: "write_clipboard",
    description: "Copie un texte dans le presse-papiers, prêt à être collé (« copie-moi ça »).",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "Texte à copier" } },
      required: ["text"],
    },
    status: () => "Copie dans le presse-papiers…",
    async run(a) {
      const text = typeof a.text === "string" ? a.text : "";
      if (!text) return { ok: false, message: "Rien à copier" };
      await native.writeClipboard(text);
      return { ok: true, message: "C'est copié, tu peux coller avec Ctrl+V" };
    },
  },

  {
    name: "look_at_screen",
    description:
      "Regarde l'écran de l'utilisateur (une capture, sans cliquer) pour répondre à une question sur ce qui " +
      "s'affiche : « qu'est-ce que c'est que cette erreur ? », « tu vois quoi ? », « aide-moi avec ce formulaire ».",
    parameters: {
      type: "object",
      properties: { question: { type: "string", description: "Ce qu'il faut regarder ou expliquer à l'écran" } },
      required: ["question"],
    },
    status: () => "Je regarde ton écran…",
    async run(a, ctx) {
      if (!vision) return { ok: false, message: "Il faut une clé Gemini pour que je puisse regarder l'écran" };
      if (!(await claudeAllowed(ctx, "Claude veut regarder ton écran"))) return REFUSED;
      const image = await native.captureScreen();
      const description = await vision(image, str(a.question) || "Décris ce qui s'affiche à l'écran.", ctx.signal);
      return { ok: true, message: description, data: { seen: description } };
    },
  },
];
