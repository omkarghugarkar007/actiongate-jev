import { createHash, timingSafeEqual } from "node:crypto";
import type { ProxyPrincipal, ProxyPrincipalResolver } from "./types.js";

export interface ProxyTokenGrant extends ProxyPrincipal {
  token: string;
}

/**
 * Resolves a downstream bearer token to a principal in constant time, so a caller
 * cannot learn a valid token by timing the comparison.
 */
export function staticTokenResolver(grants: readonly ProxyTokenGrant[]): ProxyPrincipalResolver {
  const byDigest = new Map<string, ProxyPrincipal>();
  for (const { token, ...principal } of grants) {
    if (token.length < 16) throw new Error("A proxy token must be at least 16 characters");
    byDigest.set(digest(token), principal);
  }
  const digests = [...byDigest.keys()];
  return async (token) => {
    if (!token) return undefined;
    const candidate = digest(token);
    let matched: ProxyPrincipal | undefined;
    // Compare against every configured token so the work does not depend on which
    // one matches.
    for (const known of digests) {
      if (timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(known, "hex"))) {
        matched = byDigest.get(known);
      }
    }
    return matched;
  };
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(" ");
  if (!value || scheme?.toLowerCase() !== "bearer") return undefined;
  return value.trim() || undefined;
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
