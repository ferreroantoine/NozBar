import { describe, expect, it } from "vitest";
import { onFocusLost } from "./focus";

describe("onFocusLost", () => {
  it("ferme la bulle quand l'utilisateur part lui-même (clic, Alt+Tab, touche Windows)", () => {
    expect(onFocusLost({ mouse: true, keys: false }, { recording: false, justOpened: false })).toBe("close");
    expect(onFocusLost({ mouse: false, keys: true }, { recording: false, justOpened: false })).toBe("close");
  });

  it("reprend le focus quand une fenêtre s'ouvre toute seule (appli lancée)", () => {
    expect(onFocusLost({ mouse: false, keys: false }, { recording: false, justOpened: false })).toBe("refocus");
  });

  it("ne fait rien pendant l'enregistrement de la voix ou juste après l'ouverture", () => {
    expect(onFocusLost({ mouse: true, keys: false }, { recording: true, justOpened: false })).toBe("ignore");
    expect(onFocusLost({ mouse: true, keys: false }, { recording: false, justOpened: true })).toBe("ignore");
  });
});
