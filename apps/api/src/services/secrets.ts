import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Secret resolution for deployments that use a secret manager.
 *
 * Rather than build a client per vendor — each of which would be untestable here
 * and stale within a year — this resolves three indirections that every secret
 * manager already supports: an environment variable it populates, a file it
 * mounts, or a command it exposes.
 *
 *   ACTIONGATE_GRANT_KEYS=env:GRANT_KEYS_FROM_VAULT
 *   ACTIONGATE_GRANT_KEYS=file:/run/secrets/grant-keys
 *   ACTIONGATE_GRANT_KEYS=cmd:vault kv get -field=keys secret/actiongate
 *
 * A plain value passes through unchanged, so nothing has to change to adopt this.
 */
export type SecretScheme = "env" | "file" | "cmd";

export interface ResolveSecretOptions {
  /** Commands are disabled by default: a config value that executes is a large step. */
  allowCommands?: boolean;
  env?: NodeJS.ProcessEnv;
}

export class SecretResolutionError extends Error {
  constructor(public readonly scheme: SecretScheme, message: string) {
    super(message);
    this.name = "SecretResolutionError";
  }
}

export function resolveSecret(value: string | undefined, options: ResolveSecretOptions = {}): string | undefined {
  if (!value) return value;
  const match = /^(env|file|cmd):(.*)$/s.exec(value);
  if (!match) return value;

  const scheme = match[1] as SecretScheme;
  const reference = match[2]!.trim();
  if (!reference) throw new SecretResolutionError(scheme, `${scheme}: reference is empty`);

  if (scheme === "env") {
    const resolved = (options.env ?? process.env)[reference];
    if (resolved === undefined) throw new SecretResolutionError(scheme, `Environment variable ${reference} is not set`);
    return resolved;
  }

  if (scheme === "file") {
    try {
      // Trailing newlines are near-universal in mounted secrets and are not part
      // of the secret, so stripping them avoids a class of baffling auth failures.
      return readFileSync(reference, "utf8").replace(/\r?\n$/, "");
    } catch (error) {
      throw new SecretResolutionError(scheme, `Cannot read secret file ${reference}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  if (!options.allowCommands) {
    throw new SecretResolutionError("cmd", "Command secrets are disabled. Pass allowCommands explicitly to enable them.");
  }
  const [command, ...args] = reference.split(/\s+/);
  if (!command) throw new SecretResolutionError("cmd", "cmd: no command given");
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 10_000 }).replace(/\r?\n$/, "");
  } catch (error) {
    throw new SecretResolutionError("cmd", `Secret command failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

/** Resolves a whole set, reporting every failure at once rather than the first. */
export function resolveSecrets(
  values: Readonly<Record<string, string | undefined>>,
  options: ResolveSecretOptions = {}
): Record<string, string | undefined> {
  const resolved: Record<string, string | undefined> = {};
  const failures: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    try {
      resolved[key] = resolveSecret(value, options);
    } catch (error) {
      failures.push(`${key}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  if (failures.length) throw new SecretResolutionError("env", `Could not resolve secrets:\n  ${failures.join("\n  ")}`);
  return resolved;
}
