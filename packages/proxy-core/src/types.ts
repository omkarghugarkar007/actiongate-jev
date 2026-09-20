import type {
  ActionGrantConsumeRequest,
  ActionGrantConsumeResponse,
  AuthorizationRequest,
  AuthorizationResponse,
  RiskClass
} from "@actiongate/core";

export interface ActionGateEnforcementClient {
  authorize(request: AuthorizationRequest): Promise<AuthorizationResponse>;
  consumeGrant(request: ActionGrantConsumeRequest): Promise<ActionGrantConsumeResponse>;
}

/** Server-owned tool metadata, read from the ActionGate registry. */
export interface RegistryTool {
  name: string;
  operation: string;
  riskClass: RiskClass;
  enabled: boolean;
  description?: string;
  argumentSchema?: Record<string, unknown>;
}

/** Identity derived from the downstream access token, never from the request body. */
export interface ProxyPrincipal {
  tenantId: string;
  environment: AuthorizationRequest["environment"];
  actor: AuthorizationRequest["actor"];
}

export interface ProxyRegistry {
  listTools(principal: ProxyPrincipal): Promise<RegistryTool[]>;
}

export interface ProxyPrincipalResolver {
  (token: string | undefined): Promise<ProxyPrincipal | undefined>;
}
