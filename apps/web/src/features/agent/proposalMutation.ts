export class ProposalMutationBusyError extends Error {
  constructor() {
    super('Another proposal operation is already running.');
    this.name = 'ProposalMutationBusyError';
  }
}

type Listener = (owner: string | null) => void;

/** Synchronous owner claim plus async release for page-wide proposal operations. */
export class ProposalMutationCoordinator {
  private owner: string | null = null;
  private readonly listeners = new Set<Listener>();

  get activeOwner(): string | null {
    return this.owner;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.owner);
    return () => this.listeners.delete(listener);
  }

  async run<T>(owner: string, operation: () => Promise<T>): Promise<T> {
    if (this.owner !== null) throw new ProposalMutationBusyError();
    this.owner = owner;
    this.emit();
    try {
      return await operation();
    } finally {
      if (this.owner === owner) {
        this.owner = null;
        this.emit();
      }
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.owner);
  }
}
