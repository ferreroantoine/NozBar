import { describe, expect, it } from "vitest";
import { advanceSteps, formatDuration } from "./steps";

describe("advanceSteps", () => {
  it("ouvre la première étape", () => {
    expect(advanceSteps([], "Réflexion…", 100)).toEqual([{ label: "Réflexion…", startedAt: 100 }]);
  });

  it("termine l'étape en cours quand un nouveau statut arrive", () => {
    const steps = advanceSteps(advanceSteps([], "Réflexion…", 100), "Recherche…", 400);
    expect(steps).toEqual([
      { label: "Réflexion…", startedAt: 100, doneAt: 400 },
      { label: "Recherche…", startedAt: 400 },
    ]);
  });

  it("ignore un statut répété", () => {
    const steps = advanceSteps([], "Réflexion…", 100);
    expect(advanceSteps(steps, "Réflexion…", 900)).toBe(steps);
  });
});

describe("formatDuration", () => {
  it("écrit les secondes avec une virgule et une décimale", () => {
    expect(formatDuration(400)).toBe("0,4 s");
    expect(formatDuration(8200)).toBe("8,2 s");
  });
});
