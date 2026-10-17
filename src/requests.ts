import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { SummaryFailure } from "./failures.js";
import type { Generate } from "./summaries.js";

type Model = NonNullable<ReturnType<ModelRegistry["find"]>>;

/** Resolve auth through Pi, including OAuth refresh, custom headers and ambient credentials.
 * Do not gate on hasConfiguredAuth: a keyless local endpoint can also be usable.
 */
export async function authenticationIssue(
  registry: ModelRegistry,
  model: Model,
): Promise<string | undefined> {
  // Custom/older registries may offer only request-time resolution.
  if (typeof registry.getApiKeyAndHeaders !== "function") return;
  try {
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok) return "Provider authentication unavailable";
  } catch {
    return "Provider authentication unavailable";
  }
}

interface Health {
  failures: number;
  until: number;
  issue?: string;
}

/** Runtime-session scoped. No model fallback and no automatic paid retries. */
export class Requests {
  private health = new Map<string, Health>();
  private warnings = new Set<string>();
  constructor(
    private now = Date.now,
    private cooldownMs = 60_000,
  ) {}

  warnOnce(key: string, issue: string, warn: (text: string) => void): void {
    if (this.warnings.has(key)) return;
    this.warnings.add(key);
    warn(
      `Tool summaries: ${issue}. Use /login for the selected provider, then /tool-summaries retry, or /reload. No other model will be used.`,
    );
  }

  reset(): void {
    this.health.clear();
    this.warnings.clear();
  }

  status(key: string): string | undefined {
    const health = this.health.get(key);
    if (health && health.until > this.now())
      return `${health.issue}; cooldown ${Math.ceil((health.until - this.now()) / 1000)}s remaining`;
  }

  wrap(
    key: string,
    generate: Generate,
    checkAuth: () => Promise<string | undefined>,
    warn: (text: string) => void,
  ): Generate {
    return async (input, signal) => {
      const cooling = this.status(key);
      if (cooling) throw new SummaryFailure(cooling);
      try {
        const issue = await checkAuth();
        signal.throwIfAborted();
        if (issue) throw new SummaryFailure(issue, undefined, "authentication");
        const result = await generate(input, signal);
        signal.throwIfAborted();
        this.health.delete(key);
        return result;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof SummaryFailure && error.kind !== "other") {
          const health = this.health.get(key) ?? { failures: 0, until: 0 };
          health.failures++;
          if (error.kind !== "provider" || health.failures >= 3) {
            health.until = this.now() + this.cooldownMs;
            health.issue = error.message;
            this.warnOnce(key, error.message, warn);
          }
          this.health.set(key, health);
        }
        throw error;
      }
    };
  }
}
