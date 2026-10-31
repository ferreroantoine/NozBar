import { describe, expect, it } from "vitest";
import { parseLine, toolActivity } from "./claude-code-stream";

// Lignes réelles capturées avec Claude Code 2.1.310 (raccourcies aux champs utiles).
const SID = "7debeaf6-ac1b-4bef-b29e-bd134b7358d9";
const INIT = `{"type":"system","subtype":"init","cwd":"C:\\\\x","session_id":"${SID}","tools":["Bash"]}`;
const START = `{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-haiku-5-5","content":[]}},"session_id":"${SID}","parent_tool_use_id":null}`;
const DELTA = `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}},"session_id":"${SID}","parent_tool_use_id":null}`;
const RESULT = `{"type":"result","subtype":"success","is_error":false,"result":"OK","session_id":"${SID}","num_turns":1}`;

describe("parseLine", () => {
  it("lit le texte, la session et le résultat d'un vrai flux", () => {
    expect(parseLine(INIT)).toEqual([{ kind: "session", sessionId: SID }]);
    expect(parseLine(START)).toEqual([{ kind: "messageStart" }]);
    expect(parseLine(DELTA)).toEqual([{ kind: "text", text: "OK" }]);
    expect(parseLine(RESULT)).toEqual([{ kind: "result", text: "OK", sessionId: SID, isError: false }]);
  });

  it("signale les appels d'outils du fil principal", () => {
    const line = JSON.stringify({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "text", text: "Je cherche" },
          { type: "tool_use", id: "t1", name: "WebSearch", input: { query: "météo" } },
          { type: "tool_use", id: "t2", name: "mcp__nozbar__get_weather", input: { city: "Lyon" } },
        ],
      },
    });
    expect(parseLine(line)).toEqual([
      { kind: "tool", name: "WebSearch", input: { query: "météo" } },
      { kind: "tool", name: "mcp__nozbar__get_weather", input: { city: "Lyon" } },
    ]);
  });

  it("ignore le texte des sous-agents", () => {
    const sub = DELTA.replace('"parent_tool_use_id":null', '"parent_tool_use_id":"toolu_1"');
    expect(parseLine(sub)).toEqual([]);
  });

  it("marque les résultats en erreur", () => {
    const line = `{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","session_id":"${SID}"}`;
    expect(parseLine(line)).toEqual([
      { kind: "result", text: "Not logged in · Please run /login", sessionId: SID, isError: true },
    ]);
    const maxTurns = `{"type":"result","subtype":"error_max_turns","is_error":false,"session_id":"${SID}"}`;
    expect(parseLine(maxTurns)[0]).toMatchObject({ kind: "result", isError: true });
  });

  it("ignore les lignes illisibles ou inconnues", () => {
    expect(parseLine("pas du json")).toEqual([]);
    expect(parseLine(`{"type":"rate_limit_event","rate_limit_info":{}}`)).toEqual([]);
    expect(parseLine("")).toEqual([]);
  });
});

describe("toolActivity", () => {
  it("décrit en français ce que fait Claude Code", () => {
    expect(toolActivity("WebSearch", { query: "prix RTX 5090" })).toBe("Recherche : prix RTX 5090…");
    expect(toolActivity("WebFetch", { url: "https://www.lemonde.fr/a" })).toBe("Lecture de lemonde.fr…");
    expect(toolActivity("Read", { file_path: "C:\\docs\\rapport.pdf" })).toBe("Lecture de rapport.pdf…");
    expect(toolActivity("Write", { file_path: "C:\\x\\notes.md" })).toBe("Écriture de notes.md…");
    expect(toolActivity("Bash", { command: "dir" })).toBe("Commande en cours…");
    expect(toolActivity("mcp__nozbar__get_weather", { city: "Lyon" })).toBe("Météo à Lyon…");
    expect(toolActivity("Inconnu", {})).toBe("Claude travaille…");
  });
});
