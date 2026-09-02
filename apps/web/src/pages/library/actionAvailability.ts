export interface ActionAvailability {
  readonly disabled: boolean;
  readonly disabledReason?: string;
}

/** A visible action whose implementation does not exist yet. */
export function unavailableAction(reason: string): ActionAvailability {
  return { disabled: true, disabledReason: reason };
}
