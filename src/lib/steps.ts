export interface Step {
  label: string;
  startedAt: number;
  doneAt?: number;
}

/** Un nouveau statut termine l'étape en cours et en ouvre une autre ; le même statut répété ne change rien. */
export function advanceSteps(steps: Step[], label: string, now: number): Step[] {
  const last = steps[steps.length - 1];
  if (last?.label === label) return steps;
  const previous = last ? [...steps.slice(0, -1), { ...last, doneAt: now }] : [];
  return [...previous, { label, startedAt: now }];
}

/** Durée d'une étape, à la française : « 0,4 s ». */
export function formatDuration(ms: number): string {
  return `${(ms / 1000).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}
