"use server";

import { assignException, listMembers, recordAudit, transitionException } from "@payrecon/db";
import {
  canTransition,
  EXCEPTION_STATES,
  MAX_TRANSITION_NOTE_LENGTH,
  type ExceptionState,
} from "@payrecon/domain";
import { db } from "./db";
import { actionError, actionSuccess, orgAction, type ActionState } from "./actions";

/**
 * Exception workflow actions.
 *
 * Two guarantees worth stating explicitly:
 *
 *   - `expectedVersion` travels from the rendered page into the UPDATE's WHERE
 *     clause, so an operator acting on a stale view loses to whoever wrote
 *     first and is told so, instead of silently overwriting them.
 *   - an assignee id from the form is checked against this organization's
 *     membership before it is written. Without that check, a crafted request
 *     could attach an arbitrary user id to a tenant's exception.
 */

function parseVersion(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isExceptionState(value: unknown): value is ExceptionState {
  return typeof value === "string" && (EXCEPTION_STATES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

const transitionHandler = orgAction("exceptions:transition", async (context, formData) => {
  const exceptionId = formData.get("exceptionId");
  const toState = formData.get("toState");
  const fromState = formData.get("fromState");
  const expectedVersion = parseVersion(formData.get("expectedVersion"));
  const rawNote = formData.get("note");

  if (typeof exceptionId !== "string" || exceptionId.length === 0) {
    return actionError("Missing exception.", "bad_request");
  }
  if (!isExceptionState(toState)) {
    return actionError("That is not a valid state.", "bad_request");
  }
  if (expectedVersion === null) {
    return actionError("This page is out of date. Reload it and try again.", "stale_version");
  }

  // Pre-check the state machine so an illegal move produces a readable message
  // rather than the generic internal-error fallback. The repository asserts the
  // same rule again — this is presentation, not the boundary.
  if (isExceptionState(fromState) && !canTransition(fromState, toState, "user")) {
    return actionError(
      "That change is no longer possible — someone else may have moved this exception. Reload to see the current state.",
      "invalid_transition",
    );
  }

  const note = typeof rawNote === "string" ? rawNote.trim() : "";
  if (note.length > MAX_TRANSITION_NOTE_LENGTH) {
    return actionError(
      `Notes must be at most ${MAX_TRANSITION_NOTE_LENGTH} characters.`,
      "note_too_long",
    );
  }

  const result = await transitionException(db(), {
    organizationId: context.org.organizationId,
    exceptionId,
    toState,
    expectedVersion,
    actorUserId: context.org.user.id,
    note: note.length > 0 ? note : null,
    correlationId: context.correlationId,
  });

  await recordAudit(db(), {
    organizationId: context.org.organizationId,
    actor: { type: "user", userId: context.org.user.id },
    action: "exception.state_changed",
    targetType: "exception",
    targetId: exceptionId,
    correlationId: context.correlationId,
    ipHash: context.ipHash,
    // The note itself is NOT copied into the audit metadata: it lives on the
    // exception timeline, and duplicating free text widens the blast radius of
    // anything an operator pastes in by mistake.
    metadata: { fromState: result.fromState, toState: result.toState, hasNote: note.length > 0 },
  });

  return actionSuccess(`Exception moved to ${result.toState}.`);
});

export async function transitionExceptionAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return transitionHandler(previous, formData);
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

const assignHandler = orgAction("exceptions:assign", async (context, formData) => {
  const exceptionId = formData.get("exceptionId");
  const rawAssignee = formData.get("assigneeUserId");

  if (typeof exceptionId !== "string" || exceptionId.length === 0) {
    return actionError("Missing exception.", "bad_request");
  }

  const assigneeUserId =
    typeof rawAssignee === "string" && rawAssignee.length > 0 ? rawAssignee : null;

  if (assigneeUserId) {
    // Tenancy check: only a member of THIS organization may be assigned.
    const members = await listMembers(db(), context.org.organizationId);
    if (!members.some((member) => member.userId === assigneeUserId)) {
      return actionError("That person is not a member of this organization.", "invalid_assignee");
    }
  }

  await assignException(db(), {
    organizationId: context.org.organizationId,
    exceptionId,
    assigneeUserId,
    actorUserId: context.org.user.id,
    correlationId: context.correlationId,
  });

  await recordAudit(db(), {
    organizationId: context.org.organizationId,
    actor: { type: "user", userId: context.org.user.id },
    action: "exception.assigned",
    targetType: "exception",
    targetId: exceptionId,
    correlationId: context.correlationId,
    ipHash: context.ipHash,
    metadata: { assigneeUserId },
  });

  return actionSuccess(assigneeUserId ? "Exception assigned." : "Exception unassigned.");
});

export async function assignExceptionAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return assignHandler(previous, formData);
}
