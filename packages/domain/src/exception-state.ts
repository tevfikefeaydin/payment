import type { ExceptionState } from "./types";

/**
 * Exception workflow state machine.
 *
 * Transitions are defined centrally and validated on the server before any
 * write. Every accepted transition produces an audit event and is guarded by
 * optimistic concurrency (see `expectedVersion` in the exceptions repository),
 * so two operators acting simultaneously cannot silently overwrite each other.
 */

/** How a transition was initiated. */
export type TransitionActor = "user" | "system";

export interface TransitionRule {
  from: ExceptionState;
  to: ExceptionState;
  /** Who may perform it. `system` transitions come from the reconciliation engine. */
  allowedActors: ReadonlySet<TransitionActor>;
  /** Human label used in the UI and the audit timeline. */
  label: string;
}

const T = (
  from: ExceptionState,
  to: ExceptionState,
  label: string,
  actors: TransitionActor[],
): TransitionRule => ({ from, to, label, allowedActors: new Set(actors) });

export const TRANSITIONS: readonly TransitionRule[] = [
  // --- Operator-driven
  T("open", "acknowledged", "Acknowledge", ["user"]),
  T("open", "resolved", "Resolve", ["user"]),
  T("acknowledged", "resolved", "Resolve", ["user"]),
  T("acknowledged", "open", "Return to open", ["user"]),
  T("resolved", "reopened", "Reopen", ["user"]),
  T("reopened", "acknowledged", "Acknowledge", ["user"]),
  T("reopened", "resolved", "Resolve", ["user"]),

  // --- Engine-driven
  // A resolved problem detected again by a later reconciliation run is reopened
  // automatically rather than creating a duplicate exception. This is what makes
  // fingerprints safe to reuse across runs.
  T("resolved", "reopened", "Reopened automatically: problem detected again", ["system"]),
];

export function canTransition(
  from: ExceptionState,
  to: ExceptionState,
  actor: TransitionActor,
): boolean {
  return TRANSITIONS.some(
    (rule) => rule.from === from && rule.to === to && rule.allowedActors.has(actor),
  );
}

/** States an operator may move to from the current state, for rendering controls. */
export function availableTransitions(from: ExceptionState): TransitionRule[] {
  return TRANSITIONS.filter((rule) => rule.from === from && rule.allowedActors.has("user"));
}

export class InvalidTransitionError extends Error {
  readonly from: ExceptionState;
  readonly to: ExceptionState;
  constructor(from: ExceptionState, to: ExceptionState) {
    super(`Cannot move an exception from "${from}" to "${to}".`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(
  from: ExceptionState,
  to: ExceptionState,
  actor: TransitionActor,
): void {
  if (!canTransition(from, to, actor)) throw new InvalidTransitionError(from, to);
}

/**
 * Decide what a reconciliation run should do with an exception whose fingerprint
 * was detected again.
 *
 * - Active states stay as they are (re-detecting an open problem is not news,
 *   and must not reset an operator's acknowledgement).
 * - A resolved exception reopens, because the problem genuinely returned.
 */
export function stateAfterRedetection(current: ExceptionState): ExceptionState {
  return current === "resolved" ? "reopened" : current;
}

/** Maximum length of the optional note attached to a state change. */
export const MAX_TRANSITION_NOTE_LENGTH = 2000;
