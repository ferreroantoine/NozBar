import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { GeminiProvider as Assistant } from "./lib/providers/gemini";
import { native } from "./lib/native";
import { Recorder, toWavBase64 } from "./lib/recorder";
import { matchLocal } from "./lib/router";
import { errorMessage, executeTool, type Source, type ToolContext, type Ui } from "./lib/tools";
import { Markdown } from "./components/Markdown";
import { Orb, type OrbState } from "./components/Orb";
import { Sources } from "./components/Sources";

const WIDTH = 680;
const MAX_HEIGHT = 620;
const CLOSE_MS = 140;
/** Après une action simple (ouvrir une app…), la bulle se referme seule. */
const AUTO_CLOSE_MS = 1500;
/** Un enregistrement plus court est considéré comme un appui accidentel. */
const MIN_SPEECH_SECONDS = 0.35;
/** Ignore la perte de focus juste après l'ouverture. */
const BLUR_GRACE_MS = 300;

const KEY_COMMAND = /^\/(?:cle|clé|key)$/i;

/** Palier typographique : il ne fait que descendre pendant le streaming. */
function tier(text: string): "short" | "medium" | "long" {
  if (text.length < 60 && !text.includes("\n")) return "short";
  if (text.length < 300 && !/\n\s*([-*]|\d+\.)\s/.test(text)) return "medium";
  return "long";
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

export default function App() {
  const [open, setOpen] = useState(false);
  const [setup, setSetup] = useState(false);
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [level, setLevel] = useState(0);
  const [input, setInput] = useState("");
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [shortcut, setShortcut] = useState("Alt+Espace");

  const bubbleRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const assistantRef = useRef<Assistant | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const autoCloseTimer = useRef<number | undefined>(undefined);
  const openRef = useRef(false);
  const openedAt = useRef(0);

  // ---------- Cycle de vie de la bulle ----------

  function resetTurn() {
    abortRef.current?.abort();
    abortRef.current = null;
    window.clearTimeout(autoCloseTimer.current);
    setBusy(false);
    setStatus("");
    setPrompt("");
    setAnswer("");
    setSources([]);
    setError(null);
  }

  function openBubble() {
    window.clearTimeout(closeTimer.current);
    resetTurn();
    setInput("");
    assistantRef.current?.reset();
    openRef.current = true;
    openedAt.current = Date.now();
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function close() {
    if (!openRef.current) return;
    openRef.current = false;
    setOpen(false);
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setListening(false);
    setLevel(0);
    resetTurn();
    closeTimer.current = window.setTimeout(() => void native.hideBubble(), CLOSE_MS);
  }

  function openExternal(url: string) {
    native.openUrl(url).then(close, (e) => setError(errorMessage(e)));
  }

  // ---------- Tour de conversation ----------

  async function submit(raw: string) {
    const text = raw.trim();
    if (!text) return;
    if (KEY_COMMAND.test(text)) {
      setInput("");
      resetTurn();
      setSetup(true);
      return;
    }

    resetTurn();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setInput("");
    setPrompt(text);
    // Jamais d'interface vide : un état générique s'affiche dès l'envoi.
    setStatus("Réflexion…");
    setBusy(true);

    const live = () => !ctrl.signal.aborted;
    const ui: Ui = {
      status: (s) => live() && (setStatus(s), setBusy(true)),
      text: (d) => live() && setAnswer((a) => a + d),
      sources: (list) => live() && setSources(list),
    };
    const finish = (autoClose: boolean) => {
      if (!live()) return;
      setBusy(false);
      setStatus("");
      if (autoClose) autoCloseTimer.current = window.setTimeout(close, AUTO_CLOSE_MS);
    };

    try {
      const intent = matchLocal(text);
      if (intent?.kind === "reply") {
        setAnswer(intent.text);
        finish(false);
        return;
      }
      if (intent?.kind === "tool") {
        const ctx: ToolContext = {
          ui,
          signal: ctrl.signal,
          search: (q) => requireAssistant().search(q, ctrl.signal),
        };
        const result = await executeTool(intent.name, intent.args, ctx);
        if (!live()) return;
        if (result.ok || !intent.fallbackToLlm || !assistantRef.current) {
          if (result.ok) setAnswer(result.message);
          else setError(result.message);
          finish(result.ok);
          return;
        }
        // Ex. « ouvre les paramètres bluetooth » : pas une app, le LLM saura quel outil prendre.
        setStatus("Réflexion…");
      }
      await requireAssistant().send(text, ui, ctrl.signal);
      finish(false);
    } catch (e) {
      if (!live() || isAbort(e)) return;
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  function requireAssistant(): Assistant {
    if (!assistantRef.current) {
      setSetup(true);
      throw new Error("Aucune clé API Gemini enregistrée");
    }
    return assistantRef.current;
  }

  async function saveKey(raw: string) {
    const key = raw.trim();
    try {
      await native.setApiKey(key);
      setInput("");
      if (!key) {
        assistantRef.current = null;
        setAnswer("Clé supprimée.");
        return;
      }
      assistantRef.current = new Assistant(key);
      setSetup(false);
      setAnswer("Clé enregistrée dans le Gestionnaire d'identification Windows.");
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  // ---------- Push-to-talk ----------

  function startListening() {
    if (setup || !assistantRef.current) {
      setSetup(true);
      return;
    }
    resetTurn();
    recorderRef.current?.cancel();
    const rec = new Recorder();
    recorderRef.current = rec;
    setListening(true);
    setStatus("Je vous écoute…");
    rec.start(setLevel).catch((e) => {
      if (recorderRef.current !== rec) return;
      recorderRef.current = null;
      setListening(false);
      setStatus("");
      setError(`Micro indisponible : ${errorMessage(e)}`);
    });
  }

  async function stopListening() {
    const rec = recorderRef.current;
    if (!rec) return;
    recorderRef.current = null;
    setListening(false);
    setLevel(0);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const blob = await rec.stop();
      if (!blob) return setStatus("");
      setStatus("Transcription…");
      setBusy(true);
      const { data, seconds } = await toWavBase64(blob);
      if (seconds < MIN_SPEECH_SECONDS) {
        setBusy(false);
        setStatus("");
        return;
      }
      const text = await requireAssistant().transcribe(data, ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (!text) {
        setBusy(false);
        setStatus("");
        setError("Je n'ai rien entendu.");
        return;
      }
      await submit(text);
    } catch (e) {
      if (ctrl.signal.aborted || isAbort(e)) return;
      setBusy(false);
      setError(errorMessage(e));
    }
  }

  // Les écouteurs Tauri sont branchés une seule fois : ils passent par une ref vers les handlers à jour.
  const handlers = useRef({ openBubble, close, startListening, stopListening });
  handlers.current = { openBubble, close, startListening, stopListening };

  useEffect(() => {
    native.getShortcut().then((s) => s && setShortcut(s), () => {});
    native.getApiKey().then(
      (key) => {
        if (key) assistantRef.current = new Assistant(key);
        else setSetup(true);
      },
      (e) => setError(errorMessage(e)),
    );

    const win = getCurrentWindow();
    const subscriptions = [
      listen("bubble:open", () => handlers.current.openBubble()),
      listen("bubble:close", () => handlers.current.close()),
      listen("ptt:start", () => handlers.current.startListening()),
      listen("ptt:end", () => void handlers.current.stopListening()),
      // Clic en dehors de la bulle : on ferme, comme Spotlight.
      win.onFocusChanged(({ payload: focused }) => {
        if (!focused && Date.now() - openedAt.current > BLUR_GRACE_MS && !recorderRef.current) {
          handlers.current.close();
        }
      }),
    ];
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && handlers.current.close();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      subscriptions.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, []);

  // La fenêtre suit la hauteur de la bulle.
  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!el) return;
    const win = getCurrentWindow();
    let last = 0;
    const observer = new ResizeObserver(() => {
      const height = Math.min(Math.ceil(el.getBoundingClientRect().height), MAX_HEIGHT);
      if (height !== last) {
        last = height;
        void win.setSize(new LogicalSize(WIDTH, height));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ---------- Rendu ----------

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (setup) void saveKey(input);
    else void submit(input);
  };

  const orbState: OrbState = listening ? "listening" : busy ? "thinking" : "idle";
  const placeholder = setup
    ? "Collez votre clé API Gemini, puis Entrée"
    : `Demandez quelque chose… ou maintenez ${shortcut} pour parler`;
  const hasBody = Boolean(prompt || answer || status || error || sources.length);

  return (
    <div ref={bubbleRef} className={`bubble ${open ? "is-open" : ""}`}>
      <form className="bar" onSubmit={onSubmit}>
        <Orb state={orbState} level={level} />
        <input
          ref={inputRef}
          className="input"
          type={setup ? "password" : "text"}
          value={input}
          onChange={(e) => {
            window.clearTimeout(autoCloseTimer.current);
            setInput(e.target.value);
          }}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          disabled={listening}
        />
      </form>

      {hasBody && (
        <div className="body">
          {prompt && <p className="prompt">{prompt}</p>}
          {answer && (
            <Markdown className={`answer answer-${tier(answer)}`} text={answer} onLink={openExternal} />
          )}
          {status && (busy || listening) && (
            <p className={`status ${listening ? "status-listening" : ""}`}>{status}</p>
          )}
          <Sources sources={sources} onOpen={openExternal} />
          {error && <p className="error">{error}</p>}
        </div>
      )}
    </div>
  );
}
