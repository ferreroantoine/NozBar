// Outils de dialogue : l'IA pose une question à l'utilisateur dans la bulle.

import { str, type Tool } from "./types";

const MIN_CHOICES = 2;
const MAX_CHOICES = 6;

export const DIALOG_TOOLS: Tool[] = [
  {
    name: "ask_user",
    description:
      "Pose une question à l'utilisateur avec des choix cliquables (2 à 6), et attend sa réponse. " +
      "À utiliser quand la demande est ambiguë (plusieurs fichiers possibles, ville manquante…).",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "Question courte" },
        choices: { type: "array", items: { type: "string" }, description: "Réponses proposées, 2 à 6" },
        allow_text: { type: "boolean", description: "Autoriser une réponse libre tapée au clavier" },
      },
      required: ["question", "choices"],
    },
    status: () => "Question…",
    async run(a, ctx) {
      const choices = Array.isArray(a.choices) ? a.choices.map(str).filter(Boolean) : [];
      if (choices.length < MIN_CHOICES || choices.length > MAX_CHOICES) {
        return { ok: false, message: `Il faut entre ${MIN_CHOICES} et ${MAX_CHOICES} choix` };
      }
      const answer = await ctx.ui.ask(str(a.question), choices, a.allow_text === true);
      if (answer === null) return { ok: false, message: "L'utilisateur n'a pas répondu" };
      return { ok: true, message: answer, data: { answer } };
    },
  },
];
