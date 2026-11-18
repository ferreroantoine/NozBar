// Mémoire : « souviens-toi que… » ajoute un fait rappelé à l'IA à chaque conversation, « oublie… » le retire.

import { fold, MAX_MEMORIES, settingsStore } from "../settings";
import { str, type Tool } from "./types";

export const MEMORY_TOOLS: Tool[] = [
  {
    name: "remember",
    description:
      "Retient durablement un fait, une préférence ou une consigne quand l'utilisateur le demande (« souviens-toi " +
      "que… », « retiens… », « à l'avenir… »). Reformule en une phrase autonome et claire, en corrigeant les noms " +
      "mal transcrits (ex. « steam elle peur » → « steamwebhelper »).",
    parameters: {
      type: "object",
      properties: {
        fact: { type: "string", description: "Le fait à retenir, ex. « Pour fermer Steam, ferme aussi steamwebhelper »" },
      },
      required: ["fact"],
    },
    status: () => "Je retiens…",
    async run(a, ctx) {
      const fact = str(a.fact);
      if (!fact) return { ok: false, message: "Rien à retenir" };
      // Un souvenir s'applique à toutes les conversations : une page web lue par Claude ne doit pas en glisser un.
      if (ctx.origin === "claude" && (await ctx.ui.permission(`Claude veut retenir : ${fact}`, false)) === "deny") {
        return { ok: false, message: "L'utilisateur a refusé" };
      }
      if (await settingsStore.remember(fact)) return { ok: true, message: `C'est noté : ${fact}` };
      if (settingsStore.memories.length >= MAX_MEMORIES) {
        return { ok: false, message: "Ma mémoire est pleine : supprimez des souvenirs dans les paramètres" };
      }
      return { ok: true, message: "Je le savais déjà" };
    },
  },

  {
    name: "forget",
    description:
      "Oublie un fait retenu quand l'utilisateur le demande (« oublie que… »). Passe quelques mots du souvenir à retirer.",
    parameters: {
      type: "object",
      properties: { about: { type: "string", description: "Mots du souvenir à oublier, ex. « Steam »" } },
      required: ["about"],
    },
    status: () => "J'oublie…",
    async run(a, ctx) {
      const about = str(a.about);
      const matches = settingsStore.memoriesAbout(about);
      if (!matches.length) return { ok: false, message: `Je n'ai rien retenu sur « ${about} »` };
      let fact = matches[0];
      if (matches.length > 1) {
        const pick = await ctx.ui.ask("Lequel dois-je oublier ?", matches.slice(0, 6), false);
        if (pick === null) return { ok: false, message: "Rien n'a été oublié", data: { cancelled: true } };
        fact = pick;
      }
      await settingsStore.forget(settingsStore.memories.findIndex((m) => fold(m) === fold(fact)));
      return { ok: true, message: `J'ai oublié : ${fact}` };
    },
  },
];
