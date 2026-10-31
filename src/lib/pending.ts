// Question en attente d'une réponse de l'utilisateur (choix, texte libre ou confirmation).

export interface PendingRequest {
  kind: "ask" | "confirm";
  question: string;
  /** Pour une confirmation : [libellé de l'action, « Annuler »]. */
  choices: string[];
  allowText: boolean;
}

/** Une seule question à la fois : une nouvelle annule la précédente. */
export class Pending {
  current: PendingRequest | null = null;
  onChange?: (request: PendingRequest | null) => void;
  private resolve?: (value: string | null) => void;

  open(request: PendingRequest): Promise<string | null> {
    this.settle(null);
    this.current = request;
    this.onChange?.(request);
    return new Promise((resolve) => (this.resolve = resolve));
  }

  answer(value: string) {
    this.settle(value);
  }

  cancel() {
    this.settle(null);
  }

  private settle(value: string | null) {
    const resolve = this.resolve;
    if (!resolve) return;
    this.resolve = undefined;
    this.current = null;
    this.onChange?.(null);
    resolve(value);
  }
}
