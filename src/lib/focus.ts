// La bulle reste au premier plan : elle ne se ferme que si l'utilisateur part lui-même.

/** État du clavier et de la souris au moment où la bulle perd le focus (lu par le cœur Rust). */
export interface InputState {
  /** Un bouton de souris est enfoncé : clic en dehors de la bulle. */
  mouse: boolean;
  /** Alt, Windows ou Ctrl enfoncé : Alt+Tab, menu Démarrer… */
  keys: boolean;
}

/**
 * Clic ou touche de navigation : l'utilisateur part, on ferme. Sinon, une fenêtre s'est ouverte toute
 * seule : si NozBar vient de lancer quelque chose, la bulle reprend la main ; dans les autres cas
 * (paramètres, notification…), elle reste affichée sans voler le focus.
 */
export function onFocusLost(input: InputState, state: { recording: boolean; justOpened: boolean; recentLaunch: boolean }) {
  if (state.recording || state.justOpened) return "ignore";
  if (input.mouse || input.keys) return "close";
  return state.recentLaunch ? "refocus" : "ignore";
}
