import { describe, expect, it } from "vitest";
import {
  InvalidTransitionError,
  MAX_TRANSITION_NOTE_LENGTH,
  TRANSITIONS,
  assertTransition,
  availableTransitions,
  canTransition,
  stateAfterRedetection,
} from "./exception-state";
import { EXCEPTION_STATES, type ExceptionState } from "./types";

/** Every transition an operator is allowed to perform, written out independently. */
const VALID_USER_TRANSITIONS: Array<[ExceptionState, ExceptionState]> = [
  ["open", "acknowledged"],
  ["open", "resolved"],
  ["acknowledged", "resolved"],
  ["acknowledged", "open"],
  ["resolved", "reopened"],
  ["reopened", "acknowledged"],
  ["reopened", "resolved"],
];

const isValidUserTransition = (from: ExceptionState, to: ExceptionState): boolean =>
  VALID_USER_TRANSITIONS.some(([f, t]) => f === from && t === to);

describe("canTransition (user)", () => {
  it("accepts every valid operator transition", () => {
    for (const [from, to] of VALID_USER_TRANSITIONS) {
      expect(canTransition(from, to, "user"), `${from} -> ${to}`).toBe(true);
    }
  });

  it("rejects every other from/to pair, including self-transitions", () => {
    for (const from of EXCEPTION_STATES) {
      for (const to of EXCEPTION_STATES) {
        if (isValidUserTransition(from, to)) continue;
        expect(canTransition(from, to, "user"), `${from} -> ${to} must be rejected`).toBe(false);
      }
    }
  });

  it("rejects the specific invalid transitions the workflow forbids", () => {
    // An open exception cannot be "reopened" — it was never closed.
    expect(canTransition("open", "reopened", "user")).toBe(false);
    // A resolved exception must be reopened first; it cannot jump to acknowledged.
    expect(canTransition("resolved", "acknowledged", "user")).toBe(false);
    expect(canTransition("resolved", "open", "user")).toBe(false);
    expect(canTransition("acknowledged", "reopened", "user")).toBe(false);
    expect(canTransition("reopened", "open", "user")).toBe(false);
  });

  it("rejects a self-transition for every state", () => {
    for (const state of EXCEPTION_STATES) {
      expect(canTransition(state, state, "user"), state).toBe(false);
    }
  });
});

describe("canTransition (system)", () => {
  it("permits the engine only to reopen a resolved exception", () => {
    expect(canTransition("resolved", "reopened", "system")).toBe(true);
    for (const from of EXCEPTION_STATES) {
      for (const to of EXCEPTION_STATES) {
        if (from === "resolved" && to === "reopened") continue;
        expect(canTransition(from, to, "system"), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it("does not let the engine resolve or acknowledge on an operator's behalf", () => {
    expect(canTransition("open", "resolved", "system")).toBe(false);
    expect(canTransition("open", "acknowledged", "system")).toBe(false);
    expect(canTransition("reopened", "resolved", "system")).toBe(false);
  });
});

describe("assertTransition", () => {
  it("returns silently for a valid transition", () => {
    expect(() => assertTransition("open", "acknowledged", "user")).not.toThrow();
    expect(() => assertTransition("resolved", "reopened", "system")).not.toThrow();
  });

  it("throws InvalidTransitionError for an invalid transition", () => {
    expect(() => assertTransition("open", "reopened", "user")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("resolved", "acknowledged", "user")).toThrow(
      InvalidTransitionError,
    );
  });

  it("carries the offending states on the error", () => {
    let caught: unknown;
    try {
      assertTransition("resolved", "acknowledged", "user");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidTransitionError);
    const error = caught as InvalidTransitionError;
    expect(error.name).toBe("InvalidTransitionError");
    expect(error.from).toBe("resolved");
    expect(error.to).toBe("acknowledged");
    expect(error.message).toBe('Cannot move an exception from "resolved" to "acknowledged".');
  });

  it("rejects a user attempting an engine-only transition path", () => {
    // The engine may reopen; a user may too — but a user may not acknowledge
    // straight out of resolved, which is the engine-adjacent shortcut.
    expect(() => assertTransition("open", "resolved", "system")).toThrow(InvalidTransitionError);
  });
});

describe("availableTransitions", () => {
  it("offers the operator exactly the valid next states", () => {
    const targets = (from: ExceptionState) =>
      availableTransitions(from)
        .map((r) => r.to)
        .sort();

    expect(targets("open")).toEqual(["acknowledged", "resolved"]);
    expect(targets("acknowledged")).toEqual(["open", "resolved"]);
    expect(targets("resolved")).toEqual(["reopened"]);
    expect(targets("reopened")).toEqual(["acknowledged", "resolved"]);
  });

  it("never offers a system-only rule to the operator", () => {
    for (const from of EXCEPTION_STATES) {
      for (const rule of availableTransitions(from)) {
        expect(rule.allowedActors.has("user")).toBe(true);
        expect(rule.from).toBe(from);
        expect(rule.label.length).toBeGreaterThan(0);
      }
    }
  });

  it("does not duplicate the resolved -> reopened control", () => {
    // The transition table lists resolved -> reopened twice (once for the user,
    // once for the engine); only one control must be rendered.
    expect(availableTransitions("resolved")).toHaveLength(1);
  });
});

describe("stateAfterRedetection", () => {
  it("reopens a resolved exception when the problem is detected again", () => {
    expect(stateAfterRedetection("resolved")).toBe("reopened");
  });

  it("leaves an open exception open", () => {
    expect(stateAfterRedetection("open")).toBe("open");
  });

  it("must NOT reset an operator's acknowledgement", () => {
    expect(stateAfterRedetection("acknowledged")).toBe("acknowledged");
  });

  it("leaves an already reopened exception reopened", () => {
    expect(stateAfterRedetection("reopened")).toBe("reopened");
  });

  it("only ever produces a state the engine is allowed to move to", () => {
    for (const state of EXCEPTION_STATES) {
      const next = stateAfterRedetection(state);
      if (next === state) continue;
      expect(canTransition(state, next, "system"), `${state} -> ${next}`).toBe(true);
    }
  });

  it("is idempotent", () => {
    for (const state of EXCEPTION_STATES) {
      const once = stateAfterRedetection(state);
      expect(stateAfterRedetection(once)).toBe(once);
    }
  });
});

describe("transition table shape", () => {
  it("references only declared states", () => {
    for (const rule of TRANSITIONS) {
      expect(EXCEPTION_STATES).toContain(rule.from);
      expect(EXCEPTION_STATES).toContain(rule.to);
      expect(rule.allowedActors.size).toBeGreaterThan(0);
    }
  });

  it("never declares a self-transition", () => {
    for (const rule of TRANSITIONS) expect(rule.from).not.toBe(rule.to);
  });

  it("bounds the transition note", () => {
    expect(MAX_TRANSITION_NOTE_LENGTH).toBe(2000);
  });
});
