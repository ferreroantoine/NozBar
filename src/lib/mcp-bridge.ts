// Pont MCP côté interface : exécute dans la bulle les outils NozBar et les demandes de permission de Claude Code.

import { listen } from "@tauri-apps/api/event";
import { native } from "./native";
import { categoryOf, decide, settingsStore, type SettingsStore } from "./settings";
import { errorMessage, executeTool, TOOLS, type ToolContext, type Ui } from "./tools";

/** Claude Code a sa propre recherche web, et il est lui-même l'expert. */
const EXCLUDED = new Set(["web_search", "ask_expert"]);
/** Au-delà, une commande ne peut pas être relue raisonnablement dans la bulle : elle est refusée. */
const MAX_COMMAND_CHARS = 2000;

export interface McpCall {
  id: number;
  name: string;
  args: Record<string, unknown>;
}

export type ActiveTurn = { ui: Ui; signal: AbortSignal } | null;

export function mcpToolList() {
  return TOOLS.filter((t) => !EXCLUDED.has(t.name)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
  }));
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Question posée à l'utilisateur pour une action de Claude Code. */
export function describeRequest(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Bash":
    case "PowerShell":
      // En entier : une fin de commande cachée pourrait contenir l'action dangereuse.
      return `Claude veut exécuter : ${str(input.command)}`;
    case "Read":
      return `Claude veut lire : ${str(input.file_path)}`;
    case "Glob":
    case "Grep":
      return `Claude veut chercher dans : ${str(input.path) || "vos dossiers"}`;
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return `Claude veut écrire : ${str(input.file_path) || str(input.notebook_path)}`;
    default:
      return `Claude veut utiliser ${tool}`;
  }
}

export async function handleMcpCall(
  call: McpCall,
  active: ActiveTurn,
  store: SettingsStore = settingsStore,
): Promise<{ text: string; isError: boolean }> {
  const args = call.args ?? {};
  if (call.name === "approve") {
    const tool = str(args.tool_name);
    const input = args.input && typeof args.input === "object" ? (args.input as Record<string, unknown>) : {};
    const deny = (message: string) => ({ text: JSON.stringify({ behavior: "deny", message }), isError: false });
    // Sans tour en cours (bulle fermée), personne ne peut répondre : on refuse.
    if (!active || active.signal.aborted) return deny("Aucune conversation en cours");
    const tooLong = str(input.command).length > MAX_COMMAND_CHARS;
    const category = categoryOf(tool);
    const allowed = await decide(
      category,
      // Une commande qu'on ne peut pas relire n'est pas proposée : c'est un refus.
      // « Toujours autoriser » n'est proposé que si une catégorie peut le retenir.
      async () => (tooLong ? "deny" : active.ui.permission(describeRequest(tool, input), category !== null)),
      store,
    );
    if (!allowed) {
      return deny(
        tooLong
          ? "Commande trop longue pour être relue : découpe-la en étapes plus courtes"
          : "Refusé par l'utilisateur (ou par ses paramètres)",
      );
    }
    return { text: JSON.stringify({ behavior: "allow", updatedInput: input }), isError: false };
  }

  if (!active || active.signal.aborted) return { text: "Aucune conversation NozBar en cours", isError: true };
  if (EXCLUDED.has(call.name) || !TOOLS.some((t) => t.name === call.name)) {
    return { text: `Outil inconnu : ${call.name}`, isError: true };
  }
  // Écrire un script puis l'ouvrir contournerait la relecture de la commande : la confirmation
  // n'afficherait qu'un nom de fichier. Claude doit passer par Bash, dont la commande s'affiche en entier.
  if (call.name === "open_file") {
    const info = await native.checkFile(str(args.path)).catch(() => null);
    if (info?.needsConfirmation && info.inClaudeWorkspace) {
      return {
        text: "Ce programme est dans ton dossier de travail : lance-le avec Bash pour que l'utilisateur voie la commande",
        isError: true,
      };
    }
  }
  const ctx: ToolContext = {
    ui: active.ui,
    signal: active.signal,
    origin: "claude",
    search: () => Promise.reject(new Error("Recherche indisponible")),
  };
  try {
    const r = await executeTool(call.name, args, ctx);
    return { text: JSON.stringify(r.ok ? { message: r.message, ...r.data } : { error: r.message }), isError: !r.ok };
  } catch (e) {
    return { text: errorMessage(e), isError: true };
  }
}

/** Publie le catalogue au serveur MCP et répond à ses appels ; renvoie la fonction d'arrêt. */
export function startMcpBridge(getActive: () => ActiveTurn): () => void {
  void native.mcpSetTools(mcpToolList());
  const unlisten = listen<McpCall>("mcp:call", async ({ payload }) => {
    const out = await handleMcpCall(payload, getActive());
    void native.mcpReply(payload.id, out.text, out.isError);
  });
  return () => void unlisten.then((stop) => stop());
}
