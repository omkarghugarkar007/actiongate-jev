import { createHash } from "node:crypto";
import { ActionGrantSigner, type ActionGrantConsumeRequest, type ActionGrantConsumeResponse, type AuthorizationRequest, type AuthorizationResponse } from "@actiongate/core";
import type { GrantRepository } from "./repository.js";

export class ActionGrantService {
  constructor(
    private readonly signer: ActionGrantSigner,
    private readonly repository: GrantRepository,
    private readonly clock: () => number = Date.now
  ) {}

  async attachGrant(request: AuthorizationRequest, response: AuthorizationResponse): Promise<AuthorizationResponse> {
    if (response.decision !== "ALLOW" || response.mode !== "enforce") return response;
    const existing = await this.repository.findByDecision(response.decisionId);
    if (existing) return { ...response, grant: this.signer.toPublicGrant(existing.claims) };

    const issued = this.signer.issue(request, response);
    const stored = await this.repository.saveIfAbsent({
      claims: issued.claims,
      tokenHash: tokenHash(issued.grant.token)
    });
    return { ...response, grant: this.signer.toPublicGrant(stored.claims) };
  }

  async consume(request: ActionGrantConsumeRequest): Promise<ActionGrantConsumeResponse> {
    const claims = this.signer.verify(request.token, request);
    const consumed = await this.repository.consume(claims.grantId, tokenHash(request.token), new Date(this.clock()));
    return {
      grantId: claims.grantId,
      decisionId: claims.decisionId,
      status: "CONSUMED",
      consumedAt: consumed.consumedAt!
    };
  }

  async revoke(grantId: string, tenantId: string) {
    const revoked = await this.repository.revoke(grantId, tenantId, new Date(this.clock()));
    return { grantId, decisionId: revoked.claims.decisionId, status: "REVOKED" as const, revokedAt: revoked.revokedAt! };
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
