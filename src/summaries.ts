import { SummaryFailure } from "./failures.js";
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

export interface SavedSummary {
  version: 1;
  id: string;
  fingerprint: string;
  summary: string;
}

function validatedSummary(text: string): string {
  const summary = cleanSummary(text);
  if (!summary)
    throw new SummaryFailure(
      "Summary response was empty or contained no usable text",
    );
  if (summary.length > 2000)
    throw new SummaryFailure(
      "Summary response exceeds the 2000-character display limit",
    );
  return summary;
}

/** Bounded display state backed by Pi session entries. */
export class Summaries {
  private entries = new Map<string, Entry>();
  private saved = new Map<string, SavedSummary>();
  private controllers = new Set<AbortController>();
  private disposed = false;
  private active = new Map<string, Promise<void>>();
  lastIssue?: string;
  lastPersistenceIssue?: string;
  constructor(
    private config: Config,
    private generate: Generate,
    private save?: (summary: SavedSummary) => void,
  ) {}

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) {
      const saved = this.saved.get(id);
      e = saved
        ? {
            status: "ready",
            fingerprint: saved.fingerprint,
            summary: saved.summary,
          }
        : { status: "idle" };
      this.entries.set(id, e);
      if (this.entries.size > 256)
        this.entries.delete(this.entries.keys().next().value!);
    }
    return e;
  }

  private remember(record: SavedSummary): void {
    this.saved.delete(record.id);
    this.saved.set(record.id, record);
    if (this.saved.size > 256)
      this.saved.delete(this.saved.keys().next().value!);
  }

  restore(data: unknown): void {
    if (!data || typeof data !== "object" || this.disposed) return;
    const record = data as Partial<SavedSummary>;
    if (
      record.version !== 1 ||
      typeof record.id !== "string" ||
      typeof record.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.fingerprint) ||
      typeof record.summary !== "string"
    )
      return;
    try {
      const summary = validatedSummary(record.summary);
      this.remember({
        version: 1,
        id: record.id,
        fingerprint: record.fingerprint,
        summary,
      });
    } catch {
      // Old or malformed session records are just misses.
    }
  }

  view(id: string, name: string, args: unknown, invalidate: () => void): Entry {
    const e = this.entry(id);
    e.invalidate = invalidate;
    return e.fingerprint === fingerprint(name, args) ? e : { status: "idle" };
  }

  private ready(id: string, e: Entry, summary: string): void {
    e.summary = summary;
    e.status = "ready";
    const record: SavedSummary = {
      version: 1,
      id,
      fingerprint: e.fingerprint!,
      summary,
    };
    this.remember(record);
    try {
      this.save?.(record);
    } catch {
      this.lastPersistenceIssue = "Could not persist summary in the session";
    }
    if (this.entries.get(id) === e) e.invalidate?.();
  }

  /** Backfill waits for capacity and can retry calls that failed during live execution. */
  async backfill(
    id: string,
    name: string,
    args: unknown,
    generate: Generate,
  ): Promise<"generated" | "skipped" | "failed" | "cancelled"> {
    while (!this.disposed) {
      const existing = this.active.get(id);
      if (existing) {
        await existing;
        continue;
      }
      const e = this.entry(id);
      if (e.status === "ready" && e.fingerprint === fingerprint(name, args))
        return "skipped";
      if (this.controllers.size >= this.config.concurrency) {
        await Promise.race(this.active.values());
        continue;
      }
      e.status = "idle";
      e.summary = undefined;
      this.start(id, name, args, undefined, generate);
      await this.active.get(id);
      if (this.disposed) return "cancelled";
      return (e.status as string) === "ready" ? "generated" : "failed";
    }
    return "cancelled";
  }

  start(
    id: string,
    name: string,
    args: unknown,
    parentSignal?: AbortSignal,
    generate: Generate = this.generate,
  ): void {
    if (this.disposed) return;
    const e = this.entry(id);
    // Rendering never initiates requests. Each actual call is started only once.
    if (e.status !== "idle") return;
    e.fingerprint = fingerprint(name, args);
    const input = JSON.stringify({ tool: name, arguments: args });
    if (input.length > this.config.maxInputChars || parentSignal?.aborted) {
      e.status = "unavailable";
      this.lastIssue = parentSignal?.aborted
        ? "Summary cancelled before request"
        : "Input exceeds configured limit";
      return;
    }
    if (this.controllers.size >= this.config.concurrency) {
      e.status = "unavailable";
      this.lastIssue = "Summary concurrency limit reached";
      return;
    }
    e.status = "pending";
    const controller = new AbortController();
    this.controllers.add(controller);
    const task = this.run(id, e, input, generate, controller, parentSignal);
    this.active.set(id, task);
    void task.finally(() => this.active.delete(id));
  }

  private async run(
    id: string,
    e: Entry,
    input: string,
    generate: Generate,
    controller: AbortController,
    parentSignal?: AbortSignal,
  ): Promise<void> {
    const abort = () =>
      controller.abort(new SummaryFailure("Summary cancelled by parent"));
    parentSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          new SummaryFailure(
            `Summary timed out after ${this.config.timeoutMs} ms`,
          ),
        ),
      this.config.timeoutMs,
    );
    // Providers that ignore cancellation must not stall the queue or save late results.
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(controller.signal.reason),
        { once: true },
      );
    });
    try {
      const text = await Promise.race([
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return generate(input, controller.signal);
        }),
        cancelled,
      ]);
      controller.signal.throwIfAborted();
      if (this.disposed) return;
      const summary = validatedSummary(text);
      this.ready(id, e, summary);
    } catch (error) {
      e.status = "unavailable";
      this.lastIssue =
        error instanceof SummaryFailure
          ? error.message
          : "Summary generation failed (unknown cause)";
      if (!this.disposed && this.entries.get(id) === e) e.invalidate?.();
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abort);
      this.controllers.delete(controller);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    this.saved.clear();
    for (const controller of this.controllers)
      controller.abort(
        new SummaryFailure("Summary cancelled on session shutdown"),
      );
  }
}
