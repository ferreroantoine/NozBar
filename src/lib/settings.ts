// Réglages de NozBar : permissions de Claude Code par catégorie, souvenirs (miroir de src-tauri/src/settings.rs).

import { native } from "./native";

export type Policy = "always" | "ask" | "never";
export type Category = "web_search" | "web_fetch" | "read_outside" | "write_outside" | "commands" | "programs";

export interface Settings {
  permissions: Record<Category, Policy>;
  /** Ce que l'utilisateur a demandé de retenir, rappelé à l'IA à chaque conversation. */
  memories: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  permissions: {
    web_search: "always",
    web_fetch: "always",
    read_outside: "ask",
    write_outside: "ask",
    commands: "ask",
    programs: "ask",
  },
  memories: [],
};

/** Au-delà, les souvenirs alourdiraient chaque requête. */
export const MAX_MEMORIES = 100;
const MAX_MEMORY_LENGTH = 300;

/** Compare deux textes sans tenir compte des accents, de la casse ni de la ponctuation. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Libellés de la fenêtre de paramètres, dans l'ordre d'affichage. */
export const CATEGORIES: { key: Category; label: string; hint: string }[] = [
  { key: "web_search", label: "Recherche web", hint: "Chercher sur internet" },
  { key: "web_fetch", label: "Lire des pages web", hint: "Ouvrir et lire une page trouvée" },
  { key: "read_outside", label: "Lire vos fichiers", hint: "En dehors de son dossier Documents\\NozBar" },
  { key: "write_outside", label: "Modifier vos fichiers", hint: "Créer ou modifier en dehors de son dossier" },
  { key: "commands", label: "Commandes système", hint: "Exécuter des commandes (terminal)" },
  { key: "programs", label: "Lancer des programmes", hint: ".exe, scripts, raccourcis…" },
];

const TOOL_CATEGORY: Record<string, Category> = {
  Bash: "commands",
  PowerShell: "commands",
  Write: "write_outside",
  Edit: "write_outside",
  MultiEdit: "write_outside",
  NotebookEdit: "write_outside",
  Read: "read_outside",
  Glob: "read_outside",
  Grep: "read_outside",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
};

/** Catégorie d'un outil de Claude Code ; `null` pour un outil sans réglage dédié. */
export const categoryOf = (tool: string): Category | null => TOOL_CATEGORY[tool] ?? null;

export class SettingsStore {
  private current: Settings = DEFAULT_SETTINGS;

  constructor(private save: (settings: Settings) => Promise<void>) {}

  get settings(): Settings {
    return this.current;
  }

  policy(category: Category): Policy {
    return this.current.permissions[category] ?? DEFAULT_SETTINGS.permissions[category];
  }

  get memories(): string[] {
    return this.current.memories;
  }

  /** Réglages lus au démarrage ou reçus d'une autre fenêtre. */
  replace(settings: Partial<Settings>) {
    this.current = {
      permissions: { ...DEFAULT_SETTINGS.permissions, ...settings.permissions },
      memories: Array.isArray(settings.memories) ? settings.memories : [],
    };
  }

  async setPolicy(category: Category, policy: Policy) {
    this.current = { ...this.current, permissions: { ...this.current.permissions, [category]: policy } };
    await this.save(this.current);
  }

  /** Retient un fait ; `false` s'il était déjà connu ou si la mémoire est pleine. */
  async remember(fact: string): Promise<boolean> {
    const text = fact.trim().slice(0, MAX_MEMORY_LENGTH);
    if (!text || this.current.memories.some((m) => fold(m) === fold(text))) return false;
    if (this.current.memories.length >= MAX_MEMORIES) return false;
    this.current = { ...this.current, memories: [...this.current.memories, text] };
    await this.save(this.current);
    return true;
  }

  async forget(index: number) {
    this.current = { ...this.current, memories: this.current.memories.filter((_, i) => i !== index) };
    await this.save(this.current);
  }

  /** Souvenirs qui parlent de `subject` (mots de 3 lettres ou plus). */
  memoriesAbout(subject: string): string[] {
    const words = fold(subject).split(" ").filter((w) => w.length >= 3);
    if (!words.length) return [];
    return this.current.memories.filter((m) => {
      const known = new Set(fold(m).split(" "));
      return words.some((w) => known.has(w));
    });
  }
}

/** Bloc ajouté aux consignes de l'IA ; vide sans souvenir. */
export function memoryPrompt(memories: string[] = settingsStore.memories): string {
  if (!memories.length) return "";
  return [
    "Ce que l'utilisateur t'a demandé de retenir (applique-le sans le rappeler) :",
    ...memories.map((m) => `- ${m}`),
  ].join("\n");
}

/** Réglages partagés par la bulle ; la fenêtre de paramètres les modifie par le cœur Rust. */
export const settingsStore = new SettingsStore((s) => native.setSettings(s));

/**
 * Applique la règle d'une catégorie : « Toujours » et « Refuser » sans rien demander, sinon la question
 * de `ask`, dont la réponse « Toujours autoriser » devient la règle.
 */
export async function decide(
  category: Category | null,
  ask: () => Promise<"once" | "always" | "deny">,
  store: SettingsStore = settingsStore,
): Promise<boolean> {
  const policy = category ? store.policy(category) : "ask";
  if (policy === "always") return true;
  if (policy === "never") return false;
  const answer = await ask();
  if (answer === "always" && category) await store.setPolicy(category, "always").catch(() => {});
  return answer !== "deny";
}
