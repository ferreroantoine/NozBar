import type { PendingRequest } from "../lib/pending";

interface Props {
  request: PendingRequest;
  onAnswer(choice: string): void;
}

/** Question de l'IA : boutons numérotés (touches 1-6), ou Entrée / Échap pour une confirmation. */
export function Choices({ request, onAnswer }: Props) {
  const confirm = request.kind === "confirm";
  return (
    <div className="choices">
      <p className="choices-question">{request.question}</p>
      <div className="choices-row">
        {request.choices.map((choice, i) => (
          <button
            key={choice}
            type="button"
            className={`choice ${confirm && i === 0 ? "choice-primary" : ""}`}
            onClick={() => onAnswer(choice)}
          >
            <kbd>{confirm ? (i === 0 ? "Entrée" : "Échap") : i + 1}</kbd>
            {choice}
          </button>
        ))}
      </div>
      {request.allowText && <p className="choices-hint">…ou tapez votre réponse, puis Entrée</p>}
    </div>
  );
}
