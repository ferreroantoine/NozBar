// Outils Windows de base : applications, web, multimédia, volume, paramètres, minuteur.

import { native } from "../native";
import { formatDuration, int, str, type Tool } from "./types";

const SETTINGS_PAGES = [
  "home", "display", "sound", "bluetooth", "network", "wifi", "notifications", "personalization",
  "power", "apps", "default-apps", "privacy", "update", "mouse", "keyboard", "language",
];

const MEDIA_ACTIONS: Record<string, { status: string; done: string }> = {
  play_pause: { status: "Lecture / pause…", done: "Lecture / pause" },
  next: { status: "Piste suivante…", done: "Piste suivante" },
  previous: { status: "Piste précédente…", done: "Piste précédente" },
  stop: { status: "Arrêt de la lecture…", done: "Lecture arrêtée" },
  mute: { status: "Coupure du son…", done: "Son coupé / rétabli" },
};

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export const SYSTEM_TOOLS: Tool[] = [
  {
    name: "open_url",
    launches: true,
    description: "Ouvre une adresse web (https) dans le navigateur par défaut.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "URL complète, commençant par https://" } },
      required: ["url"],
    },
    status: (a) => `Ouverture de ${domainOf(str(a.url))}…`,
    async run(a) {
      const url = str(a.url);
      await native.openUrl(url);
      return { ok: true, message: `${domainOf(url)} est ouvert` };
    },
  },

  {
    name: "web_search",
    description:
      "Recherche sur le web (Google). À utiliser pour l'actualité, les prix, les horaires ou tout fait récent ou incertain.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Requête de recherche" } },
      required: ["query"],
    },
    status: (a) => (str(a.query) ? `Recherche : ${str(a.query)}…` : "Recherche web en cours…"),
    async run(a, ctx) {
      const { summary, sources } = await ctx.search(str(a.query));
      ctx.ui.sources(sources);
      return {
        ok: true,
        message: summary,
        data: { sources: sources.map((s) => s.title) },
      };
    },
  },

  {
    name: "media_control",
    description: "Contrôle la lecture multimédia en cours (musique, vidéo).",
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: Object.keys(MEDIA_ACTIONS) } },
      required: ["action"],
    },
    status: (a) => MEDIA_ACTIONS[str(a.action)]?.status ?? "Contrôle multimédia…",
    async run(a) {
      const action = str(a.action);
      await native.mediaControl(action);
      return { ok: true, message: MEDIA_ACTIONS[action]?.done ?? "C'est fait" };
    },
  },

  {
    name: "set_volume",
    description:
      "Règle le volume principal. Donner `level` (0 à 100) pour une valeur absolue, ou `delta` (ex. 10, -10) pour un changement relatif. Sans argument, renvoie le volume actuel.",
    parameters: {
      type: "object",
      properties: {
        level: { type: "integer", description: "Volume cible en pourcents" },
        delta: { type: "integer", description: "Variation en points de pourcentage" },
      },
    },
    status: (a) => (int(a.level) === undefined && int(a.delta) === undefined ? "Lecture du volume…" : "Réglage du volume…"),
    async run(a) {
      const level = await native.setVolume(int(a.level), int(a.delta));
      return { ok: true, message: `Volume à ${level} %`, data: { level } };
    },
  },

  {
    name: "open_settings",
    launches: true,
    description: "Ouvre une page des Paramètres Windows.",
    parameters: {
      type: "object",
      properties: { page: { type: "string", enum: SETTINGS_PAGES } },
      required: ["page"],
    },
    status: () => "Ouverture des paramètres…",
    async run(a) {
      await native.openSettings(str(a.page));
      return { ok: true, message: "Paramètres ouverts" };
    },
  },

  {
    name: "set_timer",
    description: "Règle un minuteur. Une notification Windows apparaîtra à la fin.",
    parameters: {
      type: "object",
      properties: {
        seconds: { type: "integer", description: "Durée en secondes (1 à 86400)" },
        label: { type: "string", description: "Texte du rappel, facultatif" },
      },
      required: ["seconds"],
    },
    status: (a) => `Minuteur de ${formatDuration(int(a.seconds) ?? 0)}…`,
    async run(a) {
      const seconds = int(a.seconds) ?? 0;
      const label = str(a.label);
      await native.setTimer(seconds, "Minuteur terminé", label || `${formatDuration(seconds)} écoulées`);
      return { ok: true, message: `Minuteur réglé : ${formatDuration(seconds)}` };
    },
  },

  {
    name: "set_reminder",
    description:
      "Programme un rappel à une heure précise dans les prochaines 24 h (« rappelle-moi d'appeler Paul à 18 h »). " +
      "Une notification Windows apparaîtra à l'heure dite. Pour une durée (« dans 10 minutes »), utilise set_timer.",
    parameters: {
      type: "object",
      properties: {
        time: { type: "string", description: "Heure au format HH:MM (24 h), ex. « 18:00 »" },
        text: { type: "string", description: "Ce qu'il faut rappeler, ex. « Appeler Paul »" },
      },
      required: ["time", "text"],
    },
    status: (a) => `Rappel à ${str(a.time)}…`,
    async run(a) {
      const at = reminderTime(str(a.time), new Date());
      if (!at) return { ok: false, message: `Heure invalide : « ${str(a.time)} » (format HH:MM attendu)` };
      const seconds = Math.max(1, Math.round((at.getTime() - Date.now()) / 1000));
      const text = str(a.text) || "Rappel";
      await native.setTimer(seconds, "Rappel", text);
      const when = at.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
      const day = at.getDate() === new Date().getDate() ? "" : " demain";
      return { ok: true, message: `Je te le rappellerai${day} à ${when.replace(":", " h ")}` };
    },
  },

  {
    name: "now_playing",
    description: "Dit quelle musique ou vidéo est en cours de lecture (« c'est quoi cette musique ? »).",
    parameters: { type: "object", properties: {} },
    status: () => "Écoute en cours…",
    async run() {
      const media = await native.nowPlaying();
      if (!media || !media.title) return { ok: true, message: "Rien n'est en cours de lecture" };
      const who = media.artist ? ` de ${media.artist}` : "";
      const state = media.playing ? "" : " (en pause)";
      return { ok: true, message: `« ${media.title} »${who}${state}`, data: { ...media } };
    },
  },
];

/** Prochaine occurrence de « HH:MM » (ou « 18h30 ») : aujourd'hui, ou demain si l'heure est passée. */
export function reminderTime(raw: string, now: Date): Date | null {
  const match = /^(\d{1,2})\s*(?:h|:)\s*(\d{2})?$/i.exec(raw.trim());
  if (!match) return null;
  const [hours, minutes] = [Number(match[1]), Number(match[2] ?? 0)];
  if (hours > 23 || minutes > 59) return null;
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}
