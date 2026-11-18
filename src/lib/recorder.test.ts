import { describe, expect, it } from "vitest";
import { speechSeconds } from "./recorder";

const RATE = 16_000;

/** `parts` : [durée en secondes, amplitude] ; une sinusoïde à 200 Hz imite une voix. */
function signal(parts: [number, number][]): Float32Array {
  const total = parts.reduce((n, [s]) => n + Math.round(s * RATE), 0);
  const pcm = new Float32Array(total);
  let i = 0;
  for (const [seconds, amplitude] of parts) {
    for (let n = 0; n < Math.round(seconds * RATE); n++, i++) {
      pcm[i] = amplitude * Math.sin((2 * Math.PI * 200 * i) / RATE) + (Math.random() - 0.5) * 0.002;
    }
  }
  return pcm;
}

describe("speechSeconds", () => {
  it("ne trouve aucune parole dans un silence ou un léger bruit de fond", () => {
    expect(speechSeconds(signal([[2, 0]]), RATE)).toBe(0);
    expect(speechSeconds(signal([[2, 0.005]]), RATE)).toBe(0);
  });

  it("mesure la durée parlée entre deux silences", () => {
    const speech = speechSeconds(signal([[0.5, 0], [1, 0.2], [0.5, 0]]), RATE);
    expect(speech).toBeGreaterThan(0.9);
    expect(speech).toBeLessThan(1.1);
  });

  it("reconnaît une phrase dite sans aucune pause", () => {
    expect(speechSeconds(signal([[1.5, 0.15]]), RATE)).toBeGreaterThan(1.4);
  });
});
