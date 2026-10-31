// Passage de main à l'expert (Claude Sonnet). La Conversation intercepte l'appel quand une clé Claude existe.

import type { Tool } from "./types";

export const EXPERT_TOOL: Tool = {
  name: "ask_expert",
  description:
    "Confie la demande à un modèle expert plus puissant (Claude Sonnet), qui reprend la conversation avec les mêmes outils. " +
    "À utiliser pour un raisonnement en plusieurs étapes, une explication détaillée, le fonctionnement précis d'un logiciel, " +
    "du code, une rédaction longue, ou après un échec de ta part.",
  parameters: {
    type: "object",
    properties: { task: { type: "string", description: "Ce que l'expert doit faire, reformulé clairement" } },
    required: ["task"],
  },
  status: () => "Je passe la main à Sonnet…",
  // Atteint seulement sans clé Claude : la Conversation intercepte sinon l'appel avant exécution.
  async run() {
    return {
      ok: false,
      message: "Expert indisponible : aucune clé Claude enregistrée. Réponds toi-même et indique que /clé-claude permet de l'activer.",
    };
  },
};
