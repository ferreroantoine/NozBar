// Vérification JETABLE : charge la vraie Conversation via Vite et chronomètre quelques demandes.
// Usage : GEMINI_API_KEY=... node scripts/verify-assistant.mjs [chemin.wav]
// Les commandes Tauri (fichiers, localisation) n'existent pas ici : on les simule.

import { readFileSync } from "node:fs";
import { createServer } from "vite";

globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 0);

const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const { native } = await vite.ssrLoadModule("/src/lib/native.ts");
Object.assign(native, {
  getLocation: async () => ({ lat: 48.11, lon: -1.68 }),
  findFiles: async () => [{ name: "horizon-launcher.exe", path: "C:\\Users\\moi\\Downloads\\horizon-launcher.exe", folder: "Téléchargements", modified: 0 }],
  openFile: async (p) => console.log(`   [simulé] ouverture de ${p}`),
  openApp: async () => { throw new Error("Aucune application ne correspond"); },
});
const { Conversation } = await vite.ssrLoadModule("/src/lib/conversation.ts");
const { GeminiProvider } = await vite.ssrLoadModule("/src/lib/providers/gemini.ts");
const conversation = new Conversation(new GeminiProvider(process.env.GEMINI_API_KEY), () => null);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function ask(label, text) {
  conversation.reset();
  const t0 = performance.now();
  const statuses = [];
  const ui = {
    status: (s) => statuses.push(`${s} (${Math.round(performance.now() - t0)}ms)`),
    text: () => {},
    sources: () => {},
    ask: async (q, choices) => (console.log(`   [question] ${q} → ${choices[0]}`), choices[0]),
    confirm: async (m) => (console.log(`   [confirmation] ${m} → oui`), true),
    expert: () => statuses.push("EXPERT"),
  };
  try {
    const answer = await conversation.send(text, ui, new AbortController().signal);
    console.log(`${label.padEnd(16)} total ${Math.round(performance.now() - t0)}ms | ${statuses.join(" ; ")}`);
    console.log(`${"".padEnd(16)} « ${answer.replace(/\s+/g, " ").trim().slice(0, 220)} »`);
  } catch (e) {
    console.log(`${label.padEnd(16)} ERREUR après ${Math.round(performance.now() - t0)}ms : ${e.message}`);
  }
}

await ask("météo Lyon", "quelle météo à Lyon demain ?");
await wait(5_000);
await ask("météo ici", "quel temps fait-il ?");
await wait(5_000);
await ask("fichier", "ouvre horzon launcher il est dans mes telechargement");
await wait(5_000);
await ask("question simple", "Quelle est la capitale de l'Australie ?");

if (process.argv[2]) {
  await wait(5_000);
  const t0 = performance.now();
  const text = await conversation.transcribe(readFileSync(process.argv[2]).toString("base64"), new AbortController().signal);
  console.log(`${"transcription".padEnd(16)} ${Math.round(performance.now() - t0)}ms | « ${text} »`);
}

await vite.close();
