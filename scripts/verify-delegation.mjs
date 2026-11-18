// Vérification JETABLE : avec le vrai Gemini, quelles demandes Lite délègue-t-il, et à quel modèle ?

import { createServer } from "vite";

globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 0);
const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const { native } = await vite.ssrLoadModule("/src/lib/native.ts");
Object.assign(native, {
  getLocation: async () => ({ lat: 48.11, lon: -1.68 }),
  resolveOpen: async () => ({ kind: "nothing" }),
});
const { Conversation } = await vite.ssrLoadModule("/src/lib/conversation.ts");
const { GeminiProvider } = await vite.ssrLoadModule("/src/lib/providers/gemini.ts");

let delegated = null;
const claude = {
  model: "sonnet",
  get label() { return this.model === "opus" ? "Opus" : "Sonnet"; },
  reset() {},
  async send(text) { delegated = { model: this.model, text }; return "(réponse de l'expert)"; },
};
const conversation = new Conversation(new GeminiProvider(process.env.GEMINI_API_KEY), () => claude);
const ui = { status() {}, text() {}, sources() {}, ask: async () => null, confirm: async () => true, expert() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CASES = [
  ["simple", "Quelle est la capitale du Japon ?"],
  ["météo", "Quel temps fait-il à Lyon ?"],
  ["logiciel", "Où je trouve l'outil de détourage dans Photoshop ?"],
  ["comparaison", "Compare Windows 11 et macOS pour un développeur"],
  ["rédaction", "Écris-moi un mail pour décaler ma réunion de demain à jeudi"],
  ["difficile", "Écris un compilateur d'expressions arithmétiques en Rust avec gestion des erreurs, puis explique l'architecture"],
];

for (const [label, text] of CASES) {
  conversation.reset();
  delegated = null;
  const t0 = performance.now();
  try {
    const answer = await conversation.send(text, ui, new AbortController().signal);
    const who = delegated ? `DÉLÉGUÉ → ${delegated.model}` : "Lite répond";
    console.log(`${label.padEnd(12)} ${who.padEnd(18)} ${Math.round(performance.now() - t0)}ms | « ${answer.replace(/\s+/g, " ").slice(0, 90)} »`);
  } catch (e) {
    console.log(`${label.padEnd(12)} ERREUR : ${e.message}`);
  }
  await wait(4000);
}
await vite.close();
