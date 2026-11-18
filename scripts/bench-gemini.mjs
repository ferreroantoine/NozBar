// Banc de mesure JETABLE : reproduit les appels Gemini de NozBar et chronomètre chaque étape.
// Usage : GEMINI_API_KEY=... node scripts/bench-gemini.mjs [chemin.wav] [répétitions]

import { readFileSync } from "node:fs";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const WAV = process.argv[2];
const RUNS = Number(process.argv[3] ?? 3);

const FLASH = "gemini-flash-latest";
const LITE = "gemini-flash-lite-latest";

// Copie simplifiée de DECLARATIONS (src/lib/tools.ts).
const obj = (properties, required = []) => ({ type: "OBJECT", properties, required });
const DECLARATIONS = [
  { name: "open_app", description: "Lance une application installée (menu Démarrer ou Microsoft Store) à partir de son nom.", parameters: obj({ name: { type: "STRING" } }, ["name"]) },
  { name: "open_url", description: "Ouvre une adresse web (https) dans le navigateur par défaut.", parameters: obj({ url: { type: "STRING" } }, ["url"]) },
  { name: "web_search", description: "Recherche sur le web (Google). À utiliser pour l'actualité, la météo, les prix, les horaires ou tout fait récent ou incertain.", parameters: obj({ query: { type: "STRING" } }, ["query"]) },
  { name: "media_control", description: "Contrôle la lecture multimédia en cours (musique, vidéo).", parameters: obj({ action: { type: "STRING", enum: ["play_pause", "next", "previous", "stop", "mute"] } }, ["action"]) },
  { name: "set_volume", description: "Règle le volume principal.", parameters: obj({ level: { type: "INTEGER" }, delta: { type: "INTEGER" } }) },
  { name: "open_settings", description: "Ouvre une page des Paramètres Windows.", parameters: obj({ page: { type: "STRING" } }, ["page"]) },
  { name: "set_timer", description: "Règle un minuteur.", parameters: obj({ seconds: { type: "INTEGER" }, label: { type: "STRING" } }, ["seconds"]) },
];

const SYSTEM = [
  "Tu es NozBar, un assistant intégré à Windows, à la manière de Siri.",
  "Réponds en français, brièvement (une à trois phrases, sauf si on te demande plus), en markdown léger.",
  "Utilise les outils pour agir sur l'ordinateur plutôt que d'expliquer comment faire.",
  "Pour l'actualité, la météo ou tout fait récent ou incertain, utilise web_search.",
  "Après une action, confirme en une courte phrase sans répéter les détails techniques.",
  `Date et heure actuelles : ${new Date().toLocaleString("fr-FR", { dateStyle: "full", timeStyle: "short" })}.`,
].join("\n");

const thinking = (level) => (level ? { thinkingConfig: { thinkingLevel: level } } : {});

/** Un appel streamé : temps jusqu'au premier texte visible, temps total, appels d'outils. */
async function streamCall(model, contents, config) {
  const t0 = performance.now();
  let first;
  const parts = [];
  const calls = [];
  let version;
  let thoughtTokens = 0;
  const stream = await ai.models.generateContentStream({ model, contents, config });
  for await (const chunk of stream) {
    version ??= chunk.modelVersion;
    thoughtTokens = chunk.usageMetadata?.thoughtsTokenCount ?? thoughtTokens;
    for (const p of chunk.candidates?.[0]?.content?.parts ?? []) {
      parts.push(p);
      if (p.functionCall) calls.push(p.functionCall);
      else if (p.text && !p.thought) first ??= performance.now() - t0;
    }
  }
  return { ms: performance.now() - t0, first, parts, calls, version, thoughtTokens };
}

async function search(model, query, level) {
  const t0 = performance.now();
  const res = await ai.models.generateContent({
    model,
    contents: query,
    config: {
      systemInstruction: "Réponds en français, de façon concise et factuelle, à partir des résultats de recherche.",
      tools: [{ googleSearch: {} }],
      ...thinking(level),
    },
  });
  return { ms: performance.now() - t0, summary: res.text ?? "" };
}

/**
 * Un tour complet tel que NozBar le fait : boucle modèle → outil → modèle.
 * `mode` : "separate" (web_search = appel séparé, comme aujourd'hui) ou "grounded" (googleSearch dans l'appel principal).
 */
async function turn(text, { model, level, mode }) {
  const history = [{ role: "user", parts: [{ text }] }];
  const steps = [];
  const t0 = performance.now();
  let firstText;
  const tools = mode === "grounded"
    ? [{ googleSearch: {} }, { functionDeclarations: DECLARATIONS.filter((d) => d.name !== "web_search") }]
    : [{ functionDeclarations: DECLARATIONS }];
  const config = {
    systemInstruction: SYSTEM,
    tools,
    ...thinking(level),
    ...(mode === "grounded" ? { toolConfig: { includeServerSideToolInvocations: true } } : {}),
  };
  for (let step = 0; step < 6; step++) {
    const stepStart = performance.now() - t0;
    const r = await streamCall(model, history, config);
    if (r.first !== undefined) firstText ??= stepStart + r.first;
    steps.push(`llm ${Math.round(r.ms)}ms (réflexion ${r.thoughtTokens} tok)`);
    history.push({ role: "model", parts: r.parts });
    if (!r.calls.length) {
      const answer = r.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").replace(/\s+/g, " ").trim();
      return { total: performance.now() - t0, firstText, steps, version: r.version, answer };
    }
    const responses = [];
    for (const call of r.calls) {
      let response = { message: "C'est fait" };
      if (call.name === "web_search") {
        const s = await search(model, call.args?.query ?? text, level);
        steps.push(`search ${Math.round(s.ms)}ms`);
        response = { message: s.summary };
      } else {
        steps.push(`outil ${call.name} (simulé)`);
      }
      responses.push({ functionResponse: { id: call.id, name: call.name, response } });
    }
    history.push({ role: "user", parts: responses });
  }
  throw new Error("trop d'étapes");
}

async function transcribe(model, wavBase64, level) {
  const t0 = performance.now();
  const res = await ai.models.generateContent({
    model,
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: "audio/wav", data: wavBase64 } },
        { text: "Transcris mot pour mot ce message vocal. Réponds uniquement avec la transcription." },
      ],
    }],
    config: { ...thinking(level) },
  });
  return { ms: performance.now() - t0, text: (res.text ?? "").trim(), version: res.modelVersion };
}

const median = (xs) => {
  const s = xs.filter((x) => x !== undefined).sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.floor(s.length / 2)]) : "-";
};

const SCENARIOS = [
  ["question simple", "Quelle est la capitale de l'Australie ?"],
  ["météo", "Quel temps fait-il à Paris aujourd'hui ?"],
  ["ouvrir une app", "Ouvre Spotify"],
];

// Flash renvoie 503 (saturé) en ~5 s : on mesure Flash-Lite, que l'app utilise de toute façon en repli.
const CONFIGS = [
  ["Lite, réflexion par défaut, recherche séparée (≈ actuel après repli)", { model: LITE, level: undefined, mode: "separate" }],
  ["Lite, réflexion minimale, recherche séparée", { model: LITE, level: "minimal", mode: "separate" }],
  ["Lite, réflexion minimale, recherche intégrée", { model: LITE, level: "minimal", mode: "grounded" }],
  ["Flash, réflexion low, recherche intégrée", { model: FLASH, level: "low", mode: "grounded" }],
];
/** Pause entre deux tours pour rester sous le quota par minute de la clé gratuite. */
const GAP_MS = 8_000;
const pause = () => new Promise((r) => setTimeout(r, GAP_MS));

for (const [cname, cfg] of CONFIGS) {
  console.log(`\n=== ${cname} ===`);
  for (const [sname, text] of SCENARIOS) {
    const totals = [];
    const firsts = [];
    let detail = "";
    let version = "";
    for (let i = 0; i < RUNS; i++) {
      try {
        const r = await turn(text, cfg);
        totals.push(r.total);
        firsts.push(r.firstText);
        detail = `${r.steps.join(" → ")}\n${"".padEnd(18)}« ${r.answer.slice(0, 160)} »`;
        version = r.version ?? version;
      } catch (e) {
        detail = `ERREUR : ${String(e.message ?? e).slice(0, 300)}`;
      }
      await pause();
    }
    console.log(`${sname.padEnd(16)} total ${median(totals)}ms | 1er texte ${median(firsts)}ms | ${version} | ${detail}`);
  }
}

if (WAV) {
  const wav = readFileSync(WAV).toString("base64");
  console.log("\n=== transcription ===");
  for (const [label, model, level] of [
    ["Flash-Lite, réflexion par défaut", LITE, undefined],
    ["Flash-Lite, réflexion minimale", LITE, "minimal"],
  ]) {
    const times = [];
    let last;
    for (let i = 0; i < RUNS; i++) {
      try {
        last = await transcribe(model, wav, level);
        times.push(last.ms);
      } catch (e) {
        last = { text: `ERREUR : ${String(e.message ?? e).slice(0, 300)}` };
      }
      await pause();
    }
    console.log(`${label.padEnd(38)} ${median(times)}ms | ${last?.version ?? ""} | « ${last?.text} »`);
  }
}
