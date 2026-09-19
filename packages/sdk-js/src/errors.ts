import type { AuthorizationResponse } from "@actiongate/core";

export class ActionGateApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = "ActionGateApiError"; }
}
export class ActionBlockedError extends Error {
  constructor(public readonly authorization: AuthorizationResponse) { super(`ActionGate returned ${authorization.decision}`); this.name = "ActionBlockedError"; }
}

export class ActionGrantMissingError extends Error {
  constructor(public readonly authorization: AuthorizationResponse) {
    super("An enforced ALLOW response did not include an Action Grant");
    this.name = "ActionGrantMissingError";
  }
}
