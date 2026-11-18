import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Conversation } from "./lib/conversation";
import { startMcpBridge } from "./lib/mcp-bridge";
import { ClaudeProvider } from "./lib/providers/claude";
import { ClaudeCodeProvider } from "./lib/providers/claude-code";
import { GeminiProvider } from "./lib/providers/gemini";
import { GroqTranscriber } from "./lib/providers/groq";
import { onFocusLost, type InputState } from "./lib/focus";
import { settingsStore, type Settings } from "./lib/settings";
import { native, type Provider } from "./lib/native";
import { Pending, type PendingRequest } from "./lib/pending";
import { Recorder, toWavBase64 } from "./lib/recorder";
import { setupAfterClose } from "./lib/setup";
import { matchLocal } from "./lib/router";
import { advanceSteps, type Step } from "./lib/steps";
import { errorMessage, executeTool, type Source, type ToolContext, type Ui } from "./lib/tools";
import { loadDefaultBrowser } from "./lib/tools/browser";
import { setVision } from "./lib/tools/screen";
import { Bubble } from "./components/Bubble";

const WIDTH = 680;
const MAX_HEIGHT = 620;
/** Marges transparentes de .stage autour de la bulle, pour que son ombre ne soit pas coupée. */
const STAGE_MARGIN = 50;
const CLOSE_MS = 140;
/** Un enregistrement plus court est considéré comme un appui accidentel. */
const MIN_SPEECH_SECONDS = 0.35;
/** Durée parlée minimale (hors silence) pour qu'un message vocal soit transcrit. */
const MIN_VOICED_SECONDS = 0.2;
/** Au-delà, l'écoute s'arrête d'elle-même. */
const MAX_LISTEN_MS = 60_000;
/** Ignore la perte de focus juste après l'ouverture. */
const BLUR_GRACE_MS = 300;

const KEY_COMMAND = /^\/(?:cle|clé|key)$/i;
const CLAUDE_KEY_COMMAND = /^\/(?:cle|clé|key)[- ]?claude$/i;
const GROQ_KEY_COMMAND = /^\/(?:cle|clé|key)[- ]?groq$/i;
const SETTINGS_COMMAND = /^\/(?:param[eè]tres|reglages|réglages|settings)$/i;

/** Réponses à une demande d'autorisation (Entrée = autoriser, Échap = refuser, « Toujours » au clic seulement). */
const PERMISSION_CHOICES = ["Autoriser", "Toujours autoriser", "Refuser"];
/** Délai pendant lequel une perte de focus est attribuée à la fenêtre qu'un outil vient d'ouvrir. */
const LAUNCH_REFOCUS_MS = 4000;

const KEY_PLACEHOLDER: Record<Provider, string> = {
  gemini: "Collez votre clé API Gemini, puis Entrée",
  anthropic: "Collez votre clé API Claude (Anthropic), puis Entrée — vide pour la supprimer",
  groq: "Collez votre clé API Groq (dictée Whisper), puis Entrée — vide pour la supprimer",
};

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

export default function App() {
  const [open, setOpen] = useState(false);
  /** Saisie d'une clé API en cours, pour ce fournisseur. */
  const [setup, setSetup] = useState<Provider | null>(null);
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [level, setLevel] = useState(0);
  const [input, setInput] = useState("");
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [shortcut, setShortcut] = useState("Alt+Espace");
  const [question, setQuestion] = useState<PendingRequest | null>(null);
  /** Claude Sonnet a pris la main pour cette bulle. */
  const [expert, setExpert] = useState<string | null>(null);

  const bubbleRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const assistantRef = useRef<Conversation | null>(null);
  /** Expert optionnel : sans clé Claude, la Conversation reste sur Gemini. */
  const claudeRef = useRef<ClaudeProvider | null>(null);
  /** Claude Code connecté à l'abonnement : prioritaire sur l'API. */
  const claudeCodeRef = useRef<ClaudeCodeProvider | null>(null);
  /** Dictée par Whisper (Groq) si une clé est enregistrée ; sinon Gemini transcrit. */
  const groqRef = useRef<GroqTranscriber | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  /** Vocabulaire de la transcription, lu pendant que l'utilisateur parle. */
  const hintsRef = useRef<Promise<string[]>>(Promise.resolve([]));
  const listenTimer = useRef<number | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const openRef = useRef(false);
  const openedAt = useRef(0);
  /** Dernière fenêtre ouverte par un outil : la perte de focus qui suit est la sienne. */
  const launchedAt = useRef(0);
  const pending = useRef(new Pending()).current;
  pending.onChange = setQuestion;

  // ---------- Cycle de vie de la bulle ----------

  function resetTurn() {
    pending.cancel();
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setStatus("");
    setSteps([]);
    setPrompt("");
    setAnswer("");
    setSources([]);
    setError(null);
  }

  function openBubble() {
    window.clearTimeout(closeTimer.current);
    resetTurn();
    setInput("");
    setExpert(null);
    // Connexion ou déconnexion faite entre-temps (paramètres, terminal) : on revérifie à chaque ouverture.
    refreshClaudeCode();
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
    setSetup((s) => setupAfterClose(s, assistantRef.current !== null));
    resetTurn();
    closeTimer.current = window.setTimeout(() => void native.hideBubble(), CLOSE_MS);
  }

  function openExternal(url: string) {
    native.openUrl(url).then(close, (e) => setError(errorMessage(e)));
  }

  // ---------- Tour de conversation ----------

  function showStatus(label: string) {
    setStatus(label);
    setSteps((list) => advanceSteps(list, label, Date.now()));
  }

  async function submit(raw: string) {
    const text = raw.trim();
    if (!text) return;
    if (SETTINGS_COMMAND.test(text)) {
      // La bulle se ferme : toujours au premier plan, elle masquerait la fenêtre de paramètres.
      close();
      void native.openPreferences();
      return;
    }
    const keyFor = CLAUDE_KEY_COMMAND.test(text)
      ? "anthropic"
      : GROQ_KEY_COMMAND.test(text)
        ? "groq"
        : KEY_COMMAND.test(text)
          ? "gemini"
          : null;
    if (keyFor) {
      setInput("");
      resetTurn();
      setSetup(keyFor);
      return;
    }

    resetTurn();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setInput("");
    setPrompt(text);
    // Jamais d'interface vide : un état générique s'affiche dès l'envoi.
    showStatus("Réflexion…");
    setBusy(true);

    const live = () => !ctrl.signal.aborted;
    const ui: Ui = {
      status: (s) => live() && (showStatus(s), setBusy(true)),
      text: (d) => live() && setAnswer((a) => a + d),
      sources: (list) => live() && setSources(list),
      // Une question d'un tour annulé ne doit jamais apparaître dans une bulle rouverte.
      ask: async (q, choices, allowText) =>
        live() ? pending.open({ kind: "ask", question: q, choices, allowText }) : null,
      confirm: async (message, action) =>
        live() &&
        (await pending.open({ kind: "confirm", question: message, choices: [action, "Annuler"], allowText: false })) ===
          action &&
        live(),
      permission: async (message, remember) => {
        if (!live()) return "deny";
        const choices = remember ? PERMISSION_CHOICES : [PERMISSION_CHOICES[0], PERMISSION_CHOICES[2]];
        const choice = await pending.open({ kind: "confirm", question: message, choices, allowText: false });
        if (!live()) return "deny";
        return choice === PERMISSION_CHOICES[0] ? "once" : choice === PERMISSION_CHOICES[1] ? "always" : "deny";
      },
      launched: () => {
        launchedAt.current = Date.now();
      },
      expert: (label) => live() && setExpert(label),
    };
    // La bulle reste ouverte après une action : elle ne se ferme que si l'utilisateur part (Échap, clic dehors).
    const finish = () => {
      if (!live()) return;
      setBusy(false);
      setStatus("");
    };

    try {
      const local = matchLocal(text);
      // « Ferme Steam » alors qu'un souvenir parle de Steam : c'est l'IA, qui le connaît, qui s'en charge.
      const target = local?.kind === "tool" ? local.args.name : undefined;
      const intent =
        typeof target === "string" && assistantRef.current && settingsStore.memoriesAbout(target).length ? null : local;
      if (intent?.kind === "reply") {
        setAnswer(intent.text);
        finish();
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
        // Annulé par l'utilisateur (Échap sur le choix) : on ne relance pas l'IA derrière son dos.
        if (result.data?.cancelled) {
          finish();
          return;
        }
        if (result.ok || !intent.fallbackToLlm || !assistantRef.current) {
          if (result.ok) setAnswer(result.message);
          else setError(result.message);
          finish();
          return;
        }
        // Ex. « ouvre les paramètres bluetooth » : pas une app, le LLM saura quel outil prendre.
        showStatus("Réflexion…");
      }
      await requireAssistant().send(text, ui, ctrl.signal);
      finish();
    } catch (e) {
      if (!live() || isAbort(e)) return;
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  /** Whisper d'abord ; en cas de panne ou de quota Groq, Gemini prend le relais. */
  async function transcribe(wav: string, signal: AbortSignal, hints: string[]): Promise<string> {
    const groq = groqRef.current;
    if (groq) {
      try {
        return await groq.transcribe(wav, signal, hints);
      } catch (e) {
        if (signal.aborted || isAbort(e)) throw e;
        console.warn("[groq] transcription impossible, repli sur Gemini :", e);
      }
    }
    return requireAssistant().transcribe(wav, signal, hints);
  }

  function requireAssistant(): Conversation {
    if (!assistantRef.current) {
      setSetup("gemini");
      throw new Error("Aucune clé API Gemini enregistrée");
    }
    return assistantRef.current;
  }

  function applyKey(provider: Provider, key: string | null) {
    if (provider === "gemini") {
      const gemini = key ? new GeminiProvider(key) : null;
      assistantRef.current = gemini
        ? new Conversation(gemini, () => claudeCodeRef.current ?? claudeRef.current)
        : null;
      // C'est Gemini qui regarde les captures d'écran, quel que soit le modèle qui les demande.
      setVision(gemini && ((image, question, signal) => gemini.describeImage(image, question, signal)));
    } else if (provider === "groq") {
      groqRef.current = key ? new GroqTranscriber(key) : null;
    } else {
      claudeRef.current = key ? new ClaudeProvider(key) : null;
    }
  }

  function refreshClaudeCode() {
    native.claudeCodeStatus().then(
      ({ installed, loggedIn }) => {
        if (installed && loggedIn) claudeCodeRef.current ??= new ClaudeCodeProvider();
        else claudeCodeRef.current = null;
      },
      () => {},
    );
  }

  async function saveKey(provider: Provider, raw: string) {
    const key = raw.trim();
    try {
      await native.setApiKey(provider, key);
      setInput("");
      applyKey(provider, key || null);
      setSetup(null);
      setAnswer(key ? "Clé enregistrée dans le Gestionnaire d'identification Windows." : "Clé supprimée.");
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  // ---------- Push-to-talk ----------

  /** Raccourci tout juste enfoncé : le micro démarre tout de suite, au cas où ce serait un appui long. */
  function primeListening() {
    if (setup || !assistantRef.current || listening) return;
    recorderRef.current?.cancel();
    const rec = new Recorder();
    recorderRef.current = rec;
    hintsRef.current = native.speechHints().catch(() => []);
    rec.start(setLevel).catch((e) => {
      if (recorderRef.current !== rec) return;
      recorderRef.current = null;
      // Si l'écoute a déjà commencé, elle ne doit pas rester affichée sans micro derrière.
      setListening(false);
      setStatus("");
      setError(`Micro indisponible : ${errorMessage(e)}`);
    });
  }

  /** Appui court : ce n'était pas une prise de parole. */
  function cancelPrimed() {
    if (listening) return;
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setLevel(0);
  }

  function startListening() {
    if (setup || !assistantRef.current) {
      setSetup(setup ?? "gemini");
      return;
    }
    resetTurn();
    setListening(true);
    setStatus("Je vous écoute…");
    // Filet de sécurité : jamais d'écoute sans fin, même si le relâchement de la touche se perdait.
    window.clearTimeout(listenTimer.current);
    listenTimer.current = window.setTimeout(() => void handlers.current.stopListening(), MAX_LISTEN_MS);
    // Déjà en route depuis l'appui : on garde l'enregistrement, et donc les premiers mots.
    if (recorderRef.current) return;
    const rec = new Recorder();
    recorderRef.current = rec;
    hintsRef.current = native.speechHints().catch(() => []);
    rec.start(setLevel).catch((e) => {
      if (recorderRef.current !== rec) return;
      recorderRef.current = null;
      setListening(false);
      setStatus("");
      setError(`Micro indisponible : ${errorMessage(e)}`);
    });
  }

  async function stopListening() {
    window.clearTimeout(listenTimer.current);
    const rec = recorderRef.current;
    recorderRef.current = null;
    setListening(false);
    setLevel(0);
    if (!rec) {
      setStatus("");
      return;
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const blob = await rec.stop();
      if (!blob) return setStatus("");
      setStatus("Transcription…");
      setBusy(true);
      const { data, seconds, speech } = await toWavBase64(blob);
      if (seconds < MIN_SPEECH_SECONDS) {
        setBusy(false);
        setStatus("");
        return;
      }
      // Rien de dit : on n'interroge pas l'IA, qui inventerait une commande sur le silence.
      if (speech < MIN_VOICED_SECONDS) {
        setBusy(false);
        setStatus("");
        setError("Je n'ai rien entendu.");
        return;
      }
      const hints = [...(await hintsRef.current), ...settingsStore.memories];
      const text = await transcribe(data, ctrl.signal, hints);
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

  // ---------- Questions de l'IA ----------

  /** Entrée dans la barre pendant une question : numéro de choix, texte libre, ou validation. */
  function answerFromInput() {
    const q = pending.current;
    if (!q) return;
    const text = input.trim();
    if (q.kind === "confirm") {
      if (!text) pending.answer(q.choices[0]);
      return;
    }
    const n = Number(text);
    if (Number.isInteger(n) && n >= 1 && n <= q.choices.length) pending.answer(q.choices[n - 1]);
    else if (q.allowText && text) pending.answer(text);
    else return;
    setInput("");
  }

  function onKey(e: KeyboardEvent) {
    const q = pending.current;
    if (e.key === "Escape") {
      // Échap annule d'abord la question en cours, puis ferme la bulle.
      if (q) pending.cancel();
      else close();
      return;
    }
    // Sans texte libre, les touches 1-6 choisissent directement.
    const n = Number(e.key);
    // Pas de raccourci chiffré sur une autorisation : un chiffre tapé au mauvais moment accorderait « Toujours ».
    if (q?.kind === "ask" && !q.allowText && Number.isInteger(n) && n >= 1 && n <= q.choices.length) {
      e.preventDefault();
      pending.answer(q.choices[n - 1]);
    }
  }

  // Les écouteurs Tauri sont branchés une seule fois : ils passent par une ref vers les handlers à jour.
  const handlers = useRef({
    openBubble, close, primeListening, cancelPrimed, startListening, stopListening, onKey, applyKey, refreshClaudeCode,
  });
  handlers.current = {
    openBubble, close, primeListening, cancelPrimed, startListening, stopListening, onKey, applyKey, refreshClaudeCode,
  };

  useEffect(() => {
    native.getShortcut().then((s) => s && setShortcut(s), () => {});
    native.getApiKey("gemini").then(
      (key) => {
        if (key) handlers.current.applyKey("gemini", key);
        else setSetup("gemini");
      },
      (e) => setError(errorMessage(e)),
    );
    // Sans clé Claude, NozBar fonctionne : seul le passage à l'expert est indisponible.
    native.getApiKey("anthropic").then((key) => handlers.current.applyKey("anthropic", key), () => {});
    native.getApiKey("groq").then((key) => handlers.current.applyKey("groq", key), () => {});
    handlers.current.refreshClaudeCode();
    native.getSettings().then((s) => settingsStore.replace(s), () => {});
    void loadDefaultBrowser();
    // Claude Code appelle les outils NozBar par le serveur MCP : ils s'exécutent dans le tour en cours.
    const stopBridge = startMcpBridge(() => claudeCodeRef.current?.active ?? null);

    const subscriptions = [
      listen("bubble:open", () => handlers.current.openBubble()),
      listen("bubble:close", () => handlers.current.close()),
      // Clic hors de la bulle, ou Échap alors qu'elle n'a pas le focus (Windows le lui refuse parfois).
      listen("bubble:outside", () => {
        if (!openRef.current || recorderRef.current || Date.now() - openedAt.current < BLUR_GRACE_MS) return;
        handlers.current.close();
      }),
      listen("bubble:escape", () => handlers.current.onKey(new KeyboardEvent("keydown", { key: "Escape" }))),
      listen("ptt:prime", () => handlers.current.primeListening()),
      listen("ptt:cancel", () => handlers.current.cancelPrimed()),
      listen("ptt:start", () => handlers.current.startListening()),
      listen("ptt:end", () => void handlers.current.stopListening()),
      // Réglages modifiés dans la fenêtre de paramètres : appliqués tout de suite.
      listen<Settings>("settings:changed", ({ payload }) => settingsStore.replace(payload)),
      listen<Provider>("keys:changed", ({ payload: provider }) => {
        native.getApiKey(provider).then((key) => {
          handlers.current.applyKey(provider, key);
          if (provider === "gemini" && key) setSetup(null);
        }, () => {});
      }),
      // Clic dehors ou Alt+Tab : on ferme. Une appli qui s'ouvre toute seule : la bulle reprend la main.
      listen<InputState>("bubble:blur", ({ payload }) => {
        if (!openRef.current) return;
        const action = onFocusLost(payload, {
          recording: recorderRef.current !== null,
          justOpened: Date.now() - openedAt.current < BLUR_GRACE_MS,
          recentLaunch: Date.now() - launchedAt.current < LAUNCH_REFOCUS_MS,
        });
        if (action === "close") handlers.current.close();
        else if (action === "refocus") {
          // Une seule reprise par lancement : pas de ping-pong avec une appli qui reprend le focus.
          launchedAt.current = 0;
          void native.focusBubble();
        }
      }),
    ];
    const onKey = (e: KeyboardEvent) => handlers.current.onKey(e);
    window.addEventListener("keydown", onKey);
    return () => {
      stopBridge();
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
      // offsetHeight : la hauteur de mise en page, sans l'échelle de l'animation d'ouverture.
      const height = Math.min(el.offsetHeight, MAX_HEIGHT) + STAGE_MARGIN;
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
    if (setup) void saveKey(setup, input);
    else if (question) answerFromInput();
    else void submit(input);
  };

  const placeholder = setup
    ? KEY_PLACEHOLDER[setup]
    : question?.kind === "confirm"
      ? "Entrée pour valider, Échap pour annuler"
      : answer || prompt
        ? "Demandez autre chose…"
        : "Demandez quelque chose…";

  return (
    <Bubble
      bubbleRef={bubbleRef}
      inputRef={inputRef}
      open={open}
      secret={setup !== null}
      listening={listening}
      busy={busy}
      level={level}
      input={input}
      placeholder={placeholder}
      prompt={prompt}
      status={status}
      steps={steps}
      answer={answer}
      sources={sources}
      error={error}
      shortcut={shortcut}
      question={question}
      expert={expert}
      onInput={setInput}
      onSubmit={onSubmit}
      onClose={close}
      onAnswer={(choice) => pending.answer(choice)}
      onLink={openExternal}
      onTalkStart={startListening}
      onTalkEnd={() => void stopListening()}
    />
  );
}
