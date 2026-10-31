// Fournisseur Gemini : conversation en streaming avec boucle d'outils, recherche web, transcription.

import { GoogleGenAI, type Content, type FunctionCall, type Part } from "@google/genai";
import { executeTool, geminiDeclarations, toolStatus, type Source, type ToolContext, type Ui } from "../tools";

/**
 * Alias qui suivent les derniers modèles. Flash-Lite répond en moins d'une seconde ;
 * Flash, souvent saturé (503 après ~5 s), ne sert que de repli.
 */
const MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest"];
/** Erreurs passagères côté Google : surcharge, quota par minute, panne. */
const TRANSIENT = new Set([429, 500, 503, 504]);
/** Délai maximal d'une tentative, streaming compris. */
const ATTEMPT_TIMEOUT_MS = 30_000;
/** Garde-fou contre une boucle d'appels d'outils sans fin. */
const MAX_STEPS = 6;
const MAX_SOURCES = 5;

function httpStatus(e: unknown): number | undefined {
  if (e && typeof e === "object" && "status" in e && typeof e.status === "number") return e.status;
  const match = /"code":\s*(\d{3})/.exec(e instanceof Error ? e.message : String(e));
  return match ? Number(match[1]) : undefined;
}

/** Le SDK renvoie parfois le JSON de l'API imbriqué dans le message : on en extrait le texte utile. */
function apiMessage(raw: string): string {
  try {
    const inner = JSON.parse(raw)?.error?.message;
    return typeof inner === "string" ? apiMessage(inner) : raw;
  } catch {
    return raw;
  }
}

function friendlyError(e: unknown): Error {
  if (e instanceof DOMException && e.name === "AbortError") return e as unknown as Error;
  const status = httpStatus(e);
  const message = apiMessage(e instanceof Error ? e.message : String(e));
  if (status === 503 || status === 500 || status === 504) {
    return new Error("Gemini est saturé pour le moment. Réessayez dans quelques instants.");
  }
  if (status === 429) return new Error("Quota Gemini atteint. Réessayez dans une minute.");
  if (/api key/i.test(message)) return new Error("Clé API Gemini refusée. Tapez /clé pour la changer.");
  return new Error(message);
}

/**
 * Exécute `run` sur chaque modèle à tour de rôle, jusqu'au premier succès.
 * Sur une erreur passagère, on passe directement au modèle suivant : réessayer un modèle saturé
 * coûtait ~5 s par essai. Le quota étant compté par modèle, un 429 se contourne aussi ainsi.
 * Chaque tentative a un délai maximal : sans lui, une requête bloquée laisserait « Réflexion… » à l'infini.
 * `canRetry` évite de rejouer une réponse déjà partiellement affichée.
 */
async function withRetry<T>(
  run: (model: string, signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  onRetry?: () => void,
  canRetry: () => boolean = () => true,
): Promise<T> {
  let lastError: unknown;
  for (const model of MODELS) {
    const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)]);
    try {
      return await run(model, attemptSignal);
    } catch (e) {
      if (signal.aborted) throw e;
      const timedOut = attemptSignal.aborted;
      lastError = timedOut ? new Error("Gemini ne répond pas. Vérifiez votre connexion, puis réessayez.") : e;
      if (!canRetry() || !(timedOut || TRANSIENT.has(httpStatus(e) ?? 0))) throw friendlyError(lastError);
      onRetry?.();
    }
  }
  throw friendlyError(lastError);
}

function systemPrompt(): string {
  const now = new Date().toLocaleString("fr-FR", { dateStyle: "full", timeStyle: "short" });
  return [
    "Tu es NozBar, un assistant intégré à Windows, à la manière de Siri.",
    "Réponds en français, brièvement (une à trois phrases, sauf si on te demande plus), en markdown léger.",
    "Utilise les outils pour agir sur l'ordinateur plutôt que d'expliquer comment faire.",
    "Pour la météo, utilise get_weather. Pour l'actualité ou tout fait récent ou incertain, utilise web_search.",
    "Pour un fichier (téléchargement, document…), utilise find_file puis open_file.",
    "Après une action, confirme en une courte phrase sans répéter les détails techniques.",
    "Tu es l'assistant rapide : tu gères seul les questions simples et les actions directes (ouvrir, régler, météo, " +
      "fichiers, faits courts). Pour tout le reste, appelle ask_expert sans hésiter, sans demander la permission et " +
      "sans l'annoncer : explications détaillées, comparaisons, conseils, fonctionnement d'un logiciel (« où trouver X " +
      "dans Photoshop »), code, rédaction (mail, résumé, texte), calculs ou raisonnements en plusieurs étapes, " +
      "recherches à synthétiser, tâches à plusieurs actions (télécharger, organiser des fichiers), ou si tu n'es pas " +
      "sûr de ta réponse ou que ta tentative a échoué.",
    `Date et heure actuelles : ${now}.`,
  ].join("\n");
}

/** Réponse de Gemini, ou demande de passage de main à l'expert. */
export type GeminiReply = { answer: string } | { handoff: string; model: "sonnet" | "opus" };

export class GeminiProvider {
  private ai: GoogleGenAI;
  private history: Content[] = [];

  constructor(apiKey: string, ai?: GoogleGenAI) {
    this.ai = ai ?? new GoogleGenAI({ apiKey });
  }

  reset() {
    this.history = [];
  }

  /**
   * Envoie un message utilisateur et diffuse la réponse.
   * Avec `canHandoff`, un appel à ask_expert interrompt le tour et renvoie la tâche à confier.
   */
  async send(text: string, ui: Ui, signal: AbortSignal, canHandoff = false): Promise<GeminiReply> {
    const start = this.history.length;
    try {
      const reply = await this.turn(text, ui, signal, canHandoff);
      // L'expert reprend ce tour : on ne garde pas un appel d'outil resté sans réponse.
      if ("handoff" in reply) this.history.length = start;
      return reply;
    } catch (e) {
      // Un tour inachevé laisserait l'historique incohérent (appel d'outil sans réponse…).
      this.history.length = start;
      throw e;
    }
  }

  private async turn(text: string, ui: Ui, signal: AbortSignal, canHandoff: boolean): Promise<GeminiReply> {
    const ctx: ToolContext = { ui, signal, search: (q) => this.search(q, signal) };
    this.history.push({ role: "user", parts: [{ text }] });
    let answer = "";
    /** Outils exécutés pendant ce tour, résumés pour l'expert en cas de passage de main. */
    const done: string[] = [];

    for (let step = 0; step < MAX_STEPS; step++) {
      // On conserve les parts telles quelles : Gemini exige les signatures de pensée au tour suivant.
      const modelParts: Part[] = [];
      const calls: FunctionCall[] = [];
      await withRetry(
        async (model, attemptSignal) => {
          const stream = await this.ai.models.generateContentStream({
            model,
            contents: [...this.history],
            config: {
              systemInstruction: systemPrompt(),
              tools: [{ functionDeclarations: geminiDeclarations() }],
              abortSignal: attemptSignal,
            },
          });
          for await (const chunk of stream) {
            for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
              modelParts.push(part);
              if (part.functionCall?.name) {
                calls.push(part.functionCall);
                if (part.functionCall.name !== "ask_expert" || !canHandoff) {
                  ui.status(toolStatus(part.functionCall.name, part.functionCall.args ?? {}));
                }
              } else if (part.text && !part.thought) {
                answer += part.text;
                ui.text(part.text);
              }
            }
          }
        },
        signal,
        () => ui.status("Gemini est très sollicité, nouvel essai…"),
        () => modelParts.length === 0,
      );
      this.history.push({ role: "model", parts: modelParts });
      if (!calls.length) return { answer };

      // Le passage de main l'emporte : les autres appels du même message sont laissés à l'expert.
      const expert = canHandoff && calls.find((c) => c.name === "ask_expert");
      if (expert) {
        const task = typeof expert.args?.task === "string" ? expert.args.task : "";
        const model = expert.args?.model === "opus" ? "opus" : "sonnet";
        // Le tour est oublié : sans ce résumé, l'expert referait les actions déjà faites.
        return { handoff: done.length ? `${task}\nDéjà fait pendant ce tour :\n${done.join("\n")}` : task, model };
      }

      const responses: Part[] = [];
      for (const call of calls) {
        const result = await executeTool(call.name!, call.args ?? {}, ctx);
        if (signal.aborted) throw new DOMException("Annulé", "AbortError");
        done.push(`- ${call.name} ${JSON.stringify(call.args ?? {})} → ${result.ok ? "" : "échec : "}${result.message}`);
        responses.push({
          functionResponse: {
            id: call.id,
            name: call.name,
            response: result.ok ? { message: result.message, ...result.data } : { error: result.message },
          },
        });
      }
      this.history.push({ role: "user", parts: responses });
    }
    throw new Error("Trop d'étapes pour cette demande");
  }

  /** Recherche ancrée sur Google Search : synthèse + sources. */
  async search(query: string, signal: AbortSignal): Promise<{ summary: string; sources: Source[] }> {
    const res = await withRetry(
      (model, attemptSignal) =>
        this.ai.models.generateContent({
          model,
          contents: query,
          config: {
            systemInstruction: "Réponds en français, de façon concise et factuelle, à partir des résultats de recherche.",
            tools: [{ googleSearch: {} }],
            abortSignal: attemptSignal,
          },
        }),
      signal,
    );
    const seen = new Set<string>();
    const sources: Source[] = [];
    for (const chunk of res.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []) {
      const web = chunk.web;
      if (!web?.uri || seen.has(web.uri)) continue;
      seen.add(web.uri);
      // L'URI est une redirection Google ; le titre contient en général le domaine.
      const domain = web.domain ?? web.title ?? new URL(web.uri).hostname;
      sources.push({ url: web.uri, title: web.title ?? domain, domain });
      if (sources.length >= MAX_SOURCES) break;
    }
    return { summary: res.text ?? "", sources };
  }

  /** Transcrit un message vocal (WAV 16 kHz en base64). */
  async transcribe(wavBase64: string, signal: AbortSignal): Promise<string> {
    const res = await withRetry((model, attemptSignal) => this.ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "audio/wav", data: wavBase64 } },
            {
              text:
                "Transcris mot pour mot ce message vocal (en français, sauf s'il est dans une autre langue). " +
                "Réponds uniquement avec la transcription, sans guillemets ni commentaire. " +
                "S'il n'y a aucune parole, réponds exactement : <vide>",
            },
          ],
        },
      ],
      config: { abortSignal: attemptSignal },
    }), signal);
    const text = (res.text ?? "").trim();
    return text === "<vide>" ? "" : text;
  }
}
