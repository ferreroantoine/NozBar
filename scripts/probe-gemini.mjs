// Sonde JETABLE : un appel par modèle, espacés, avec l'erreur complète (type de quota, etc.).
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await wait(65_000); // laisser retomber le quota par minute
for (const [model, level] of [["gemini-flash-latest", "low"], ["gemini-flash-lite-latest", "minimal"]]) {
  const t0 = performance.now();
  try {
    const res = await ai.models.generateContent({
      model,
      contents: "Quelle est la capitale de l'Australie ? Réponds en une phrase.",
      config: { thinkingConfig: { thinkingLevel: level } },
    });
    console.log(`${model} OK ${Math.round(performance.now() - t0)}ms | ${res.modelVersion} | ${res.text?.trim()}`);
  } catch (e) {
    console.log(`${model} ERREUR ${Math.round(performance.now() - t0)}ms\n${String(e.message ?? e).slice(0, 2500)}`);
  }
  await wait(10_000);
}
