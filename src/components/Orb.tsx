export type OrbState = "idle" | "listening" | "thinking";

interface Props {
  state: OrbState;
  size: "sm" | "md" | "lg";
  /** Amplitude du micro entre 0 et 1, utilisée en écoute. */
  level?: number;
}

/** La mascotte : un orbe irisé qui respire, cligne des yeux et suit la voix. */
export function Orb({ state, size, level = 0 }: Props) {
  const scale = state === "listening" ? 1 + level * 0.3 : 1;
  return (
    <div className={`orb orb-${size} orb-${state}`} style={{ scale: scale.toFixed(3) }} aria-hidden>
      <i />
      <svg className="orb-face" viewBox="0 0 24 24">
        <ellipse className="orb-eye" cx="8.6" cy="10.2" rx="1.5" ry="1.9" fill="#fff" />
        <ellipse className="orb-eye" cx="15.4" cy="10.2" rx="1.5" ry="1.9" fill="#fff" />
        <path d="M8 14.6q4 3.6 8 0" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" />
      </svg>
    </div>
  );
}
