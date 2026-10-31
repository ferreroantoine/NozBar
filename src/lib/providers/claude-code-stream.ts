// Lecture du flux `--output-format stream-json` de Claude Code, ligne par ligne.

import { toolStatus } from "../tools";

export type StreamItem =
  | { kind: "session"; sessionId: string }
  | { kind: "messageStart" }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: Record<string, unknown> }
  | { kind: "result"; text: string; sessionId?: string; isError: boolean };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON externe, validé champ par champ.
type Json = Record<string, any>;

/** Une ligne illisible ou d'un type inconnu ne casse rien : elle est ignorée. */
export function parseLine(line: string): StreamItem[] {
  let msg: Json;
  try {
    msg = JSON.parse(line);
  } catch {
    return [];
  }
  if (!msg || typeof msg !== "object") return [];
  // Les sous-agents de Claude Code ont leur propre fil : seul le fil principal s'affiche.
  if (msg.parent_tool_use_id) return [];

  switch (msg.type) {
    case "system":
      return msg.subtype === "init" && typeof msg.session_id === "string"
        ? [{ kind: "session", sessionId: msg.session_id }]
        : [];
    case "stream_event": {
      const event = msg.event ?? {};
      if (event.type === "message_start") return [{ kind: "messageStart" }];
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        return [{ kind: "text", text: String(event.delta.text ?? "") }];
      }
      return [];
    }
    case "assistant":
      return (msg.message?.content ?? [])
        .filter((b: Json) => b.type === "tool_use")
        .map((b: Json) => ({ kind: "tool", name: String(b.name), input: (b.input ?? {}) as Record<string, unknown> }));
    case "result":
      return [
        {
          kind: "result",
          text: typeof msg.result === "string" ? msg.result : "",
          sessionId: typeof msg.session_id === "string" ? msg.session_id : undefined,
          isError: msg.is_error === true || msg.subtype !== "success",
        },
      ];
    default:
      return [];
  }
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "la page";
  }
}

const NOZBAR_PREFIX = "mcp__nozbar__";

/** Texte gris affiché pendant qu'un outil de Claude Code travaille. */
export function toolActivity(name: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  if (name.startsWith(NOZBAR_PREFIX)) return toolStatus(name.slice(NOZBAR_PREFIX.length), input);
  switch (name) {
    case "WebSearch":
      return str("query") ? `Recherche : ${str("query")}…` : "Recherche web…";
    case "WebFetch":
      return `Lecture de ${domain(str("url"))}…`;
    case "Read":
      return `Lecture de ${baseName(str("file_path"))}…`;
    case "Write":
    case "Edit":
      return `Écriture de ${baseName(str("file_path"))}…`;
    case "Glob":
    case "Grep":
      return "Recherche de fichiers…";
    case "Bash":
    case "PowerShell":
      return "Commande en cours…";
    case "Task":
    case "Agent":
      return "Sous-tâche en cours…";
    default:
      return "Claude travaille…";
  }
}
