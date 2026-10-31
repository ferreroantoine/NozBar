export type OrbState = "idle" | "listening" | "thinking";

interface Props {
  state: OrbState;
  /** Amplitude du micro entre 0 et 1, utilisée en écoute. */
  level: number;
}

export function Orb({ state, level }: Props) {
  const scale = state === "listening" ? 1 + level * 0.55 : 1;
  return (
    <div className={`orb orb-${state}`} aria-hidden>
      <div className="orb-core" style={{ transform: `scale(${scale.toFixed(3)})` }} />
    </div>
  );
}
