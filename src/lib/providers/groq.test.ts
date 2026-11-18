import { describe, expect, it, vi } from "vitest";
import { cleanTranscript, GroqTranscriber, spokenText, whisperPrompt } from "./groq";

describe("spokenText", () => {
  it("écarte les segments que Whisper juge silencieux", () => {
    expect(spokenText({ text: " Lance OBS.", segments: [{ text: " Lance OBS.", no_speech_prob: 0.92 }] })).toBe("");
    expect(
      spokenText({
        text: "Ferme Discord. Merci.",
        segments: [
          { text: " Ferme Discord.", no_speech_prob: 0.02 },
          { text: " Merci.", no_speech_prob: 0.8 },
        ],
      }),
    ).toBe("Ferme Discord.");
    expect(spokenText({ text: "Ferme Steam" })).toBe("Ferme Steam");
  });
});

describe("GroqTranscriber", () => {
  it("envoie l'audio à Whisper en français avec le vocabulaire, et renvoie le texte", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ text: " Ferme Steam. " }), { status: 200 }));
    const groq = new GroqTranscriber("cle", fetchFn as unknown as typeof fetch);
    const text = await groq.transcribe(btoa("RIFF"), new AbortController().signal, ["Steam", "Brave"]);
    expect(text).toBe("Ferme Steam.");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/audio/transcriptions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer cle");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("language")).toBe("fr");
    expect(form.get("prompt")).toContain("Steam, Brave.");
  });

  it("signale une clé refusée", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 401 }));
    const groq = new GroqTranscriber("mauvaise", fetchFn as unknown as typeof fetch);
    await expect(groq.transcribe(btoa("RIFF"), new AbortController().signal)).rejects.toThrow("/clé-groq");
  });
});

describe("cleanTranscript", () => {
  it("ignore les sous-titres que Whisper invente sur un silence", () => {
    expect(cleanTranscript("Sous-titres réalisés par la communauté d'Amara.org")).toBe("");
    expect(cleanTranscript("Merci d'avoir regardé !")).toBe("");
    expect(cleanTranscript("Merci de fermer Discord")).toBe("Merci de fermer Discord");
  });
});

describe("whisperPrompt", () => {
  it("garde les premiers noms sans dépasser la limite", () => {
    const prompt = whisperPrompt(Array.from({ length: 500 }, (_, i) => `Application ${i}`));
    expect(prompt.length).toBeLessThanOrEqual(700);
    expect(prompt).toContain("Application 0");
    expect(prompt).not.toContain("Application 499");
  });
});
