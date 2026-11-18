import { useEffect, useState, type CSSProperties, type FormEvent, type RefObject } from "react";
import type { PendingRequest } from "../lib/pending";
import { formatDuration, type Step } from "../lib/steps";
import type { Source } from "../lib/tools";
import { Choices } from "./Choices";
import { Markdown } from "./Markdown";
import { Orb, type OrbState } from "./Orb";
import { Sources } from "./Sources";

/** Hauteur de chaque barre du spectre, en fraction de sa hauteur maximale. */
const WAVE_BARS = [0.3, 0.6, 0.85, 0.45, 0.7, 1, 0.5, 0.8, 0.35, 0.95, 0.65, 0.3, 0.75, 0.45, 0.9, 0.4];
const WAVE_DURATIONS = [0.8, 1, 0.5, 1, 0.4];
const TICK_MS = 250;

/** Palier typographique : il ne fait que descendre pendant le streaming. */
function tier(text: string): "short" | "medium" | "long" {
  if (text.length < 60 && !text.includes("\n")) return "short";
  if (text.length < 300 && !/\n\s*([-*]|\d+\.)\s/.test(text)) return "medium";
  return "long";
}

interface Props {
  bubbleRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  open: boolean;
  /** Saisie d'une clé API en cours. */
  secret: boolean;
  listening: boolean;
  busy: boolean;
  level: number;
  input: string;
  placeholder: string;
  prompt: string;
  status: string;
  steps: Step[];
  answer: string;
  sources: Source[];
  error: string | null;
  shortcut: string;
  question: PendingRequest | null;
  expert: string | null;
  onInput(value: string): void;
  onSubmit(e: FormEvent): void;
  onClose(): void;
  onAnswer(choice: string): void;
  onLink(url: string): void;
  onTalkStart(): void;
  onTalkEnd(): void;
}

export function Bubble(p: Props) {
  const hasContent = Boolean(p.prompt || p.answer || p.error || p.sources.length || p.question);
  const view = p.listening || (p.busy && !hasContent) ? "listen" : hasContent ? "card" : "idle";
  const orbState: OrbState = p.listening ? "listening" : p.busy ? "thinking" : "idle";
  const working = p.busy && !p.question;
  const hasField = view === "idle" || (view === "card" && !working);

  // Le champ change de place selon l'état : il reprend le focus à chaque déplacement.
  useEffect(() => {
    if (p.open && hasField) p.inputRef.current?.focus();
  }, [p.open, hasField, view]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!working) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [working]);

  const field = (
    <input
      ref={p.inputRef}
      className="input"
      type={p.secret ? "password" : "text"}
      value={p.input}
      onChange={(e) => p.onInput(e.target.value)}
      placeholder={p.placeholder}
      spellCheck={false}
      autoComplete="off"
    />
  );

  const keys = p.shortcut.split("+").map((key) => <kbd key={key}>{key}</kbd>);
  const className = [
    "bubble",
    `bubble-${view}`,
    p.open && "is-open",
    (p.secret || p.input) && "is-wide",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    // Autour de la bulle, la fenêtre est transparente : un clic y vaut un clic dehors.
    <div className="stage" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div ref={p.bubbleRef} className={className}>
        {view === "idle" && (
          <form className="pill" onSubmit={p.onSubmit}>
            <Orb state={orbState} size="sm" />
            {field}
            <span className="keys">{keys}</span>
          </form>
        )}

        {view === "listen" && (
          <div className="listen" style={{ "--level": p.level } as CSSProperties}>
            <Orb state={orbState} size="lg" level={p.level} />
            <div className="listen-text">
              <small>{p.status}</small>
              {p.listening ? "Parlez, puis relâchez pour envoyer" : "Un instant"}
            </div>
            {p.listening && (
              <div className="wave">
                {WAVE_BARS.map((height, i) => (
                  <u
                    key={i}
                    style={{
                      height: `${height * 100}%`,
                      animationDelay: `${-i * 0.13}s`,
                      animationDuration: `${WAVE_DURATIONS[i % WAVE_DURATIONS.length]}s`,
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {view === "card" && (
          <>
            <header className="card-head">
              <Orb state={orbState} size="md" />
              <div className="card-question" title={p.prompt}>
                {p.prompt || "NozBar"}
              </div>
              {p.expert && (
                <span className="badge" title={`Claude ${p.expert} répond jusqu'à la fermeture de la bulle`}>
                  {p.expert}
                </span>
              )}
              <div className="card-state">
                {working && p.steps[0] && `${Math.max(0, Math.floor((now - p.steps[0].startedAt) / 1000))} s`}
                {!p.busy && p.answer && !p.error && (
                  <>
                    <span className="card-dot">●</span> Terminé
                  </>
                )}
              </div>
              <button type="button" className="card-close" onClick={p.onClose} aria-label="Fermer">
                ✕
              </button>
            </header>
            <div className="card-sep" />

            <div className="card-body">
              {working && p.steps.length > 0 && (
                <ul className="steps">
                  {p.steps.map((step) => (
                    <li key={step.startedAt} className={`step ${step.doneAt ? "step-done" : "step-run"}`}>
                      <span className="step-icon">{step.doneAt && "✓"}</span>
                      {step.label}
                      <span className="step-time">
                        {step.doneAt ? formatDuration(step.doneAt - step.startedAt) : "en cours"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {p.answer && <Markdown className={`answer answer-${tier(p.answer)}`} text={p.answer} onLink={p.onLink} />}
              {p.question && <Choices request={p.question} onAnswer={p.onAnswer} />}
              <Sources sources={p.sources} onOpen={p.onLink} />
              {p.error && <p className="error">{p.error}</p>}
            </div>

            {working && <div className="progress" />}

            {hasField && (
              <>
                <form className="card-input" onSubmit={p.onSubmit}>
                  {field}
                  <button
                    type="button"
                    className="mic"
                    aria-label="Maintenir pour parler"
                    title="Maintenir pour parler"
                    onPointerDown={() => {
                      // Le bouton disparaît dès que l'écoute commence : le relâchement s'écoute sur la fenêtre.
                      window.addEventListener("pointerup", p.onTalkEnd, { once: true });
                      p.onTalkStart();
                    }}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                      <rect x="9" y="3" width="6" height="12" rx="3" />
                      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                    </svg>
                  </button>
                </form>
                <footer className="card-foot">
                  <span>
                    <kbd>Échap</kbd>fermer
                  </span>
                  <span>
                    <kbd>Entrée</kbd>envoyer
                  </span>
                  <span>{keys}parler</span>
                </footer>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
