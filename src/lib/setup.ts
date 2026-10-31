// Saisie d'une clé API dans la barre.

import type { Provider } from "./native";

/**
 * À la fermeture de la bulle, la saisie d'une clé est abandonnée : sinon la prochaine question tapée
 * serait enregistrée comme clé. Seule exception : la clé Gemini manquante, sans laquelle rien ne marche.
 */
export function setupAfterClose(setup: Provider | null, hasGeminiKey: boolean): Provider | null {
  return setup === "gemini" && !hasGeminiKey ? "gemini" : null;
}
