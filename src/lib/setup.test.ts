import { describe, expect, it } from "vitest";
import { setupAfterClose } from "./setup";

describe("setupAfterClose", () => {
  it("abandonne la saisie de la clé Claude à la fermeture de la bulle", () => {
    expect(setupAfterClose("anthropic", true)).toBeNull();
    expect(setupAfterClose("anthropic", false)).toBeNull();
  });

  it("abandonne le changement d'une clé Gemini déjà enregistrée", () => {
    expect(setupAfterClose("gemini", true)).toBeNull();
  });

  it("garde la saisie de la clé Gemini tant qu'il n'y en a aucune", () => {
    expect(setupAfterClose("gemini", false)).toBe("gemini");
    expect(setupAfterClose(null, true)).toBeNull();
  });
});
