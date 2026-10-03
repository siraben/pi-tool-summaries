import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { Config } from "./config.js";

export const summaryPrompt =
  "Describe the intended action of the Bash command in the supplied JSON data for someone who finds shell commands hard to read. Use a subjectless present-participle phrase beginning with an action such as “Listing”, “Checking”, “Building”, or “Inspecting”. Describe intended operations using only information supported by the command. Preserve meaningful writes, overwrites, deletions, network operations, and failure conditions; distinguish conditional && chains from unconditional semicolons and newlines. For a short simple command (under 200 characters), use a brief clause, usually 6–15 words. For a long or compound command, summarize its supported purpose and key effects in one concise sentence, usually 15–40 words. Add detail only as needed to preserve important effects and control flow. Return only the summary as plain prose.";

export type Generate = (input: string, signal: AbortSignal) => Promise<string>;
interface Entry {
  fingerprint?: string;
  summary?: string;
  status: "idle" | "pending" | "ready" | "unavailable";
  invalidate?: () => void;
}
export function fingerprint(name: string, args: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ tool: name, arguments: args }))
    .digest("hex");
}
export function cleanSummary(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Bounded, session-local display cache. Never modifies arguments or tool results. */
export class Summaries {
  private entries = new Map<string, Entry>();
  private controllers = new Set<AbortController>();
  private active = 0;
  lastIssue?: string;
  constructor(
    private config: Config,
    private generate: Generate,
  ) {}

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) {
      e = { status: "idle" };
      this.entries.set(id, e);
      if (this.entries.size > 256)
        this.entries.delete(this.entries.keys().next().value!);
    }
    return e;
  }

  view(id: string, name: string, args: unknown, invalidate: () => void): Entry {
    const e = this.entry(id);
    e.invalidate = invalidate;
    return e.fingerprint === fingerprint(name, args) ? e : { status: "idle" };
  }

  start(
    id: string,
    name: string,
    args: unknown,
    parentSignal?: AbortSignal,
    generate: Generate = this.generate,
  ): void {
    const e = this.entry(id);
    // One request per actual execution; redraws and expansion never spend tokens.
    if (e.status !== "idle") return;
    e.fingerprint = fingerprint(name, args);
    const input = JSON.stringify({ tool: name, arguments: args });
    if (
      input.length > this.config.maxInputChars ||
      this.active >= this.config.concurrency ||
      parentSignal?.aborted
    ) {
      e.status = "unavailable";
      this.lastIssue =
        input.length > this.config.maxInputChars
          ? "Input exceeds configured limit"
          : "Busy or cancelled";
      return;
    }
    e.status = "pending";
    this.active++;
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort();
    parentSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.config.timeoutMs);
    // Race the abort too: a provider that ignores cancellation cannot stall the cache.
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("Summary cancelled or timed out")),
        { once: true },
      );
    });
    void Promise.race([
      Promise.resolve().then(() => generate(input, controller.signal)),
      cancelled,
    ])
      .then((text) => {
        const summary = cleanSummary(text);
        if (!summary || summary.length > 2000)
          throw new Error("Empty or oversized summary");
        e.summary = summary;
        e.status = "ready";
      })
      .catch(() => {
        e.status = "unavailable";
        // Never expose provider errors: they can contain request data or credentials.
        this.lastIssue =
          "Summary unavailable (provider error, empty response, cancellation, or timeout)";
      })
      .finally(() => {
        clearTimeout(timer);
        parentSignal?.removeEventListener("abort", abort);
        this.controllers.delete(controller);
        this.active--;
        if (this.entries.get(id) === e) e.invalidate?.();
      });
  }

  dispose(): void {
    this.entries.clear();
    for (const controller of this.controllers) controller.abort();
  }
}
