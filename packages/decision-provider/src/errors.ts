export class ProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(`${code}:${message}`);
    this.name = "ProviderError";
  }
}
