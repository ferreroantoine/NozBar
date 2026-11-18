// Dictée par Whisper (large-v3-turbo) chez Groq : un vrai moteur de transcription, rapide et précis en français.

const ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL = "whisper-large-v3-turbo";
const TIMEOUT_MS = 15_000;
/** Whisper ne lit que les ~224 derniers jetons de la consigne : on garde les noms les plus utiles (en tête). */
const MAX_PROMPT_CHARS = 700;

/**
 * Phrases que Whisper invente sur un silence ou un bruit (sous-titres de vidéos vus à l'entraînement).
 * Comparées sans accents ni ponctuation.
 */
const HALLUCINATIONS = [
  "sous titres realises par la communaute d amara org",
  "sous titrage st 501",
  "sous titrage societe radio canada",
  "merci d avoir regarde",
  "merci d avoir regarde cette video",
  "merci",
  "abonnez vous",
  "thank you for watching",
  "you",
];

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Texte vide si Whisper n'a entendu que du silence (et l'a « sous-titré »). */
export function cleanTranscript(text: string): string {
  const trimmed = text.trim();
  return HALLUCINATIONS.includes(fold(trimmed)) ? "" : trimmed;
}

/** Consigne de Whisper : un début de phrase dans le style attendu, suivi des noms à savoir écrire. */
export function whisperPrompt(hints: string[]): string {
  let prompt = "Commande vocale pour NozBar, assistant Windows : ouvre, ferme, mets, lance.";
  for (const hint of hints) {
    const next = `${prompt} ${hint.trim()},`;
    if (next.length > MAX_PROMPT_CHARS) break;
    prompt = next;
  }
  return prompt.replace(/,$/, ".");
}

function wavBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "audio/wav" });
}

export class GroqTranscriber {
  constructor(
    private apiKey: string,
    private fetchFn: typeof fetch = (...args) => fetch(...args),
  ) {}

  async transcribe(wavBase64: string, signal: AbortSignal, hints: string[] = []): Promise<string> {
    const form = new FormData();
    form.append("file", wavBlob(wavBase64), "message.wav");
    form.append("model", MODEL);
    form.append("language", "fr");
    form.append("temperature", "0");
    // verbose_json : chaque segment indique la probabilité qu'il n'y ait en fait aucune parole.
    form.append("response_format", "verbose_json");
    form.append("prompt", whisperPrompt(hints));
    const res = await this.fetchFn(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    if (!res.ok) {
      if (res.status === 401) throw new Error("Clé Groq refusée. Tapez /clé-groq pour la changer.");
      if (res.status === 429) throw new Error("Quota Groq atteint");
      throw new Error(`Groq a répondu ${res.status}`);
    }
    return cleanTranscript(spokenText((await res.json()) as WhisperResponse));
  }
}

interface WhisperResponse {
  text?: string;
  segments?: { text: string; no_speech_prob?: number }[];
}

/** Au-delà, Whisper estime lui-même que le segment est du silence (qu'il a « sous-titré » quand même). */
const NO_SPEECH_THRESHOLD = 0.6;

/** Le texte, sans les segments que Whisper juge silencieux. */
export function spokenText(body: WhisperResponse): string {
  if (!body.segments?.length) return body.text ?? "";
  return body.segments
    .filter((s) => (s.no_speech_prob ?? 0) < NO_SPEECH_THRESHOLD)
    .map((s) => s.text.trim())
    .join(" ");
}
