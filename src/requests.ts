import { SummaryFailure } from "./failures.js";
import type { SummaryUsage } from "./provider.js";
import type { Generate } from "./summaries.js";

/** Session-local usage and failure suppression. Authentication belongs to Pi. */
export class Requests {
  readonly stats = {
    requests: 0,
    reported: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  private failures = new Map<
    string,
    { count: number; until: number; warned: boolean }
  >();

  recordUsage(usage?: SummaryUsage): void {
    if (!usage) return;
    this.stats.reported++;
    this.stats.input += usage.input;
    this.stats.output += usage.output;
    this.stats.cacheRead += usage.cacheRead;
    this.stats.cacheWrite += usage.cacheWrite;
    this.stats.cost += usage.cost.total;
  }

  coolingDown(key: string): boolean {
    return (this.failures.get(key)?.until ?? 0) > Date.now();
  }

  wrap(
    key: string,
    generate: Generate,
    warn: (text: string) => void,
  ): Generate {
    return async (input, signal) => {
      if (this.coolingDown(key))
        throw new SummaryFailure(
          "Summary model cooling down; use /reload to try again",
        );
      signal.throwIfAborted();
      this.stats.requests++;
      try {
        const text = await generate(input, signal);
        signal.throwIfAborted();
        const failure = this.failures.get(key);
        if (failure) {
          failure.count = 0;
          failure.until = 0;
        }
        return text;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof SummaryFailure && error.kind !== "other") {
          const failure = this.failures.get(key) ?? {
            count: 0,
            until: 0,
            warned: false,
          };
          failure.count++;
          if (error.kind !== "provider" || failure.count >= 3)
            failure.until = Date.now() + 60_000;
          if (!failure.warned) {
            failure.warned = true;
            warn(
              `Tool summaries: ${error.message}. Original calls remain visible.`,
            );
          }
          this.failures.set(key, failure);
        }
        throw error;
      }
    };
  }
}
