import { describe, expect, it } from "vitest";
import { onFocusLost } from "./focus";

const idle = { recording: false, justOpened: false, recentLaunch: false };

describe("onFocusLost", () => {
  it("ferme la bulle quand l'utilisateur part lui-même (clic, Alt+Tab, touche Windows)", () => {
    expect(onFocusLost({ mouse: true, keys: false }, idle)).toBe("close");
    expect(onFocusLost({ mouse: false, keys: true }, idle)).toBe("close");
    expect(onFocusLost({ mouse: true, keys: false }, { ...idle, recentLaunch: true })).toBe("close");
  });

  it("reprend le focus seulement juste après avoir lancé une application", () => {
    expect(onFocusLost({ mouse: false, keys: false }, { ...idle, recentLaunch: true })).toBe("refocus");
  });

  it("ne vole pas le focus aux autres fenêtres (paramètres, notifications…)", () => {
    expect(onFocusLost({ mouse: false, keys: false }, idle)).toBe("ignore");
  });

  it("ne fait rien pendant l'enregistrement de la voix ou juste après l'ouverture", () => {
    expect(onFocusLost({ mouse: true, keys: false }, { ...idle, recording: true })).toBe("ignore");
    expect(onFocusLost({ mouse: true, keys: false }, { ...idle, justOpened: true })).toBe("ignore");
  });
});
