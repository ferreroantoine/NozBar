// Pont MCP côté interface : exécute dans la bulle les outils NozBar et les demandes de permission de Claude Code.

import { listen } from "@tauri-apps/api/event";
import { native } from "./native";
import { errorMessage, executeTool, TOOLS, type ToolContext, type Ui } from "./tools";

/** Claude Code a sa propre recherche web, et il est lui-même l'expert. */
const EXCLUDED = new Set(["web_search", "ask_expert"]);
const MAX_COMMAND_CHARS = 200;

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
const shorten = (s: string) => (s.length > MAX_COMMAND_CHARS ? `${s.slice(0, MAX_COMMAND_CHARS)}…` : s);

/** Question posée à l'utilisateur pour une action de Claude Code. */
export function describeRequest(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Bash":
    case "PowerShell":
      return `Claude veut exécuter : ${shorten(str(input.command))}`;
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return `Claude veut écrire : ${str(input.file_path) || str(input.notebook_path)}`;
    default:
      return `Claude veut utiliser ${tool}`;
  }
}

export async function handleMcpCall(call: McpCall, active: ActiveTurn): Promise<{ text: string; isError: boolean }> {
  const args = call.args ?? {};
  if (call.name === "approve") {
    const tool = str(args.tool_name);
    const input = args.input && typeof args.input === "object" ? (args.input as Record<string, unknown>) : {};
    // Sans tour en cours (bulle fermée), personne ne peut répondre : on refuse.
    const allowed = active !== null && !active.signal.aborted && (await active.ui.confirm(describeRequest(tool, input), "Autoriser"));
    const decision = allowed
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: active ? "Refusé par l'utilisateur" : "Aucune conversation en cours" };
    return { text: JSON.stringify(decision), isError: false };
  }

  if (!active || active.signal.aborted) return { text: "Aucune conversation NozBar en cours", isError: true };
  if (EXCLUDED.has(call.name) || !TOOLS.some((t) => t.name === call.name)) {
    return { text: `Outil inconnu : ${call.name}`, isError: true };
  }
  const ctx: ToolContext = {
    ui: active.ui,
    signal: active.signal,
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
