// Catalogue d'outils : déclaration pour le LLM, message gris immédiat, exécution locale.

import { Type, type FunctionDeclaration } from "@google/genai";
import { native } from "./native";

export interface Source {
  url: string;
  title: string;
  domain: string;
}

/** Retours vers l'interface pendant un tour. */
export interface Ui {
  status(text: string): void;
  text(delta: string): void;
  sources(list: Source[]): void;
}

export interface ToolContext {
  ui: Ui;
  search(query: string): Promise<{ summary: string; sources: Source[] }>;
}

export type Args = Record<string, unknown>;

export interface ToolResult {
  ok: boolean;
  /** Phrase courte en français, affichée telle quelle pour les commandes locales. */
  message: string;
  data?: Record<string, unknown>;
}

interface Tool {
  declaration: FunctionDeclaration;
  status(args: Args): string;
  run(args: Args, ctx: ToolContext): Promise<ToolResult>;
}

/** Le texte gris reste affiché au moins ce temps, même si l'action est instantanée. */
const MIN_STATUS_MS = 400;

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

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined);

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  if (s || !parts.length) parts.push(`${s} s`);
  return parts.join(" ");
}

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

const TOOLS: Record<string, Tool> = {
  open_app: {
    declaration: {
      name: "open_app",
      description: "Lance une application installée (menu Démarrer ou Microsoft Store) à partir de son nom.",
      parameters: {
        type: Type.OBJECT,
        properties: { name: { type: Type.STRING, description: "Nom de l'application, ex. « Spotify »" } },
        required: ["name"],
      },
    },
    status: (a) => `Ouverture de ${str(a.name) || "l'application"}…`,
    async run(a) {
      const app = await native.openApp(str(a.name));
      return { ok: true, message: `${app.name} est ouvert`, data: { app: app.name } };
    },
  },

  open_url: {
    declaration: {
      name: "open_url",
      description: "Ouvre une adresse web (https) dans le navigateur par défaut.",
      parameters: {
        type: Type.OBJECT,
        properties: { url: { type: Type.STRING, description: "URL complète, commençant par https://" } },
        required: ["url"],
      },
    },
    status: (a) => `Ouverture de ${domainOf(str(a.url))}…`,
    async run(a) {
      const url = str(a.url);
      await native.openUrl(url);
      return { ok: true, message: `${domainOf(url)} est ouvert` };
    },
  },

  web_search: {
    declaration: {
      name: "web_search",
      description:
        "Recherche sur le web (Google). À utiliser pour l'actualité, la météo, les prix, les horaires ou tout fait récent ou incertain.",
      parameters: {
        type: Type.OBJECT,
        properties: { query: { type: Type.STRING, description: "Requête de recherche" } },
        required: ["query"],
      },
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

  media_control: {
    declaration: {
      name: "media_control",
      description: "Contrôle la lecture multimédia en cours (musique, vidéo).",
      parameters: {
        type: Type.OBJECT,
        properties: { action: { type: Type.STRING, enum: Object.keys(MEDIA_ACTIONS) } },
        required: ["action"],
      },
    },
    status: (a) => MEDIA_ACTIONS[str(a.action)]?.status ?? "Contrôle multimédia…",
    async run(a) {
      const action = str(a.action);
      await native.mediaControl(action);
      return { ok: true, message: MEDIA_ACTIONS[action]?.done ?? "C'est fait" };
    },
  },

  set_volume: {
    declaration: {
      name: "set_volume",
      description:
        "Règle le volume principal. Donner `level` (0 à 100) pour une valeur absolue, ou `delta` (ex. 10, -10) pour un changement relatif. Sans argument, renvoie le volume actuel.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          level: { type: Type.INTEGER, description: "Volume cible en pourcents" },
          delta: { type: Type.INTEGER, description: "Variation en points de pourcentage" },
        },
      },
    },
    status: (a) => (int(a.level) === undefined && int(a.delta) === undefined ? "Lecture du volume…" : "Réglage du volume…"),
    async run(a) {
      const level = await native.setVolume(int(a.level), int(a.delta));
      return { ok: true, message: `Volume à ${level} %`, data: { level } };
    },
  },

  open_settings: {
    declaration: {
      name: "open_settings",
      description: "Ouvre une page des Paramètres Windows.",
      parameters: {
        type: Type.OBJECT,
        properties: { page: { type: Type.STRING, enum: SETTINGS_PAGES } },
        required: ["page"],
      },
    },
    status: () => "Ouverture des paramètres…",
    async run(a) {
      await native.openSettings(str(a.page));
      return { ok: true, message: "Paramètres ouverts" };
    },
  },

  set_timer: {
    declaration: {
      name: "set_timer",
      description: "Règle un minuteur. Une notification Windows apparaîtra à la fin.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          seconds: { type: Type.INTEGER, description: "Durée en secondes (1 à 86400)" },
          label: { type: Type.STRING, description: "Texte du rappel, facultatif" },
        },
        required: ["seconds"],
      },
    },
    status: (a) => `Minuteur de ${formatDuration(int(a.seconds) ?? 0)}…`,
    async run(a) {
      const seconds = int(a.seconds) ?? 0;
      const label = str(a.label);
      await native.setTimer(seconds, "Minuteur terminé", label || `${formatDuration(seconds)} écoulées`);
      return { ok: true, message: `Minuteur réglé : ${formatDuration(seconds)}` };
    },
  },
};

export const DECLARATIONS: FunctionDeclaration[] = Object.values(TOOLS).map((t) => t.declaration);

export function toolStatus(name: string, args: Args): string {
  return TOOLS[name]?.status(args) ?? "Action en cours…";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// On laisse le navigateur peindre le texte gris avant de lancer l'action.
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

export async function executeTool(name: string, args: Args, ctx: ToolContext): Promise<ToolResult> {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, message: `Outil inconnu : ${name}` };

  const shownAt = performance.now();
  ctx.ui.status(tool.status(args));
  await nextPaint();

  let result: ToolResult;
  try {
    result = await tool.run(args, ctx);
  } catch (e) {
    result = { ok: false, message: errorMessage(e) };
  }
  const wait = MIN_STATUS_MS - (performance.now() - shownAt);
  if (wait > 0) await sleep(wait);
  return result;
}
