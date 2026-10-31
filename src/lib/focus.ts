// La bulle reste au premier plan : elle ne se ferme que si l'utilisateur part lui-même.

/** État du clavier et de la souris au moment où la bulle perd le focus (lu par le cœur Rust). */
export interface InputState {
  /** Un bouton de souris est enfoncé : clic en dehors de la bulle. */
  mouse: boolean;
  /** Alt, Windows ou Ctrl enfoncé : Alt+Tab, menu Démarrer… */
  keys: boolean;
}

/**
 * Sans clic ni touche, la perte de focus vient d'une fenêtre qui s'est ouverte toute seule
 * (application lancée par NozBar ou par Claude) : la bulle reprend la main.
 */
export function onFocusLost(input: InputState, state: { recording: boolean; justOpened: boolean }) {
  if (state.recording || state.justOpened) return "ignore";
  return input.mouse || input.keys ? "close" : "refocus";
}
