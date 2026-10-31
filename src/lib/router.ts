// Niveau 0 : intentions reconnues localement, sans LLM (< 20 ms).

import type { Args } from "./tools";

export type LocalIntent =
  | { kind: "tool"; name: string; args: Args; /** En cas d'échec, on laisse le LLM réessayer. */ fallbackToLlm?: boolean }
  | { kind: "reply"; text: string };

function normalize(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[?!.,;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const OPEN = /^(?:peux[- ]tu |tu peux )?(?:ouvre|ouvrir|lance|lancer|demarre|demarrer)\s+(?:moi\s+)?(?:l'|la |le |les |un |une )?(.+)$/;
const PLACE_HINT = /\s+(?:(?:il|elle|qui)\s+(?:est|se trouve)|(?:dans|sur)\s+(?:mes|mon|ma|le|la|les))\b/;
const DOMAIN =/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/;
const SETTINGS = /^(?:parametres|reglages)(?: windows)?$/;

const VOLUME_SET = /^(?:mets |regle )?(?:le )?(?:volume|son)\s+(?:a\s+)?(\d{1,3})\s*%?$/;
const VOLUME_UP = /^(?:(?:monte|augmente)(?: le)? (?:son|volume)|plus fort)$/;
const VOLUME_DOWN = /^(?:(?:baisse|diminue)(?: le)? (?:son|volume)|moins fort)$/;
const MUTE = /^(?:coupe le son|mute|silence)$/;

const MEDIA: [RegExp, string][] = [
  [/^(?:pause|mets(?: en)? pause|play|lecture|reprends|reprendre)$/, "play_pause"],
  [/^(?:suivant|(?:chanson|piste|musique|morceau) suivante?)$/, "next"],
  [/^(?:precedent|(?:chanson|piste|musique|morceau) precedente?)$/, "previous"],
];

const TIMER = /^(?:mets |lance |regle )?(?:un )?(?:minuteur|timer|chrono)\s+(?:de\s+)?(\d+)\s*(secondes?|sec|s|minutes?|min|mn|m|heures?|h)$/;
const TIME = /^(?:quelle heure(?: est[- ]il)?|il est quelle heure)$/;
const DATE = /^(?:quel jour (?:on est|sommes-nous|est-on|est-ce)|on est quel jour|quelle est la date(?: d'aujourd'hui)?)$/;

function unitSeconds(unit: string): number {
  if (unit.startsWith("h")) return 3600;
  if (unit.startsWith("m")) return 60;
  return 1;
}

export function matchLocal(input: string): LocalIntent | null {
  const text = normalize(input);

  const open = OPEN.exec(text);
  if (open) {
    // « … il est dans mes téléchargements », « … qui est sur mon bureau » : précisions de lieu, pas le nom.
    const target = open[1].split(PLACE_HINT)[0].trim();
    if (DOMAIN.test(target)) return { kind: "tool", name: "open_url", args: { url: `https://${target}` } };
    if (SETTINGS.test(target)) return { kind: "tool", name: "open_settings", args: { page: "home" } };
    // « paramètres bluetooth » : le LLM choisira la bonne page de open_settings.
    if (/^(?:parametres|reglages) /.test(target)) return null;
    return { kind: "tool", name: "open_app", args: { name: target }, fallbackToLlm: true };
  }

  const volume = VOLUME_SET.exec(text);
  if (volume) return { kind: "tool", name: "set_volume", args: { level: Math.min(100, Number(volume[1])) } };
  if (VOLUME_UP.test(text)) return { kind: "tool", name: "set_volume", args: { delta: 10 } };
  if (VOLUME_DOWN.test(text)) return { kind: "tool", name: "set_volume", args: { delta: -10 } };
  if (MUTE.test(text)) return { kind: "tool", name: "media_control", args: { action: "mute" } };

  for (const [re, action] of MEDIA) {
    if (re.test(text)) return { kind: "tool", name: "media_control", args: { action } };
  }

  const timer = TIMER.exec(text);
  if (timer) {
    return { kind: "tool", name: "set_timer", args: { seconds: Number(timer[1]) * unitSeconds(timer[2]) } };
  }

  const now = new Date();
  if (TIME.test(text)) {
    return { kind: "reply", text: `Il est ${now.getHours()} h ${String(now.getMinutes()).padStart(2, "0")}` };
  }
  if (DATE.test(text)) {
    const date = now.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    return { kind: "reply", text: `Nous sommes le ${date}` };
  }

  return null;
}
