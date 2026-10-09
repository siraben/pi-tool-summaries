import {
  createBashToolDefinition,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { configFromSettings, type Config } from "./config.js";
import { Summaries } from "./summaries.js";
import { createGenerate, reasoningIssue } from "./provider.js";
import { withSummary, withSummaryRenderers } from "./renderer.js";

const summaryEntryType = "tool-summaries:summary";
type SummaryTool = "bash" | "codemode";
type ToolRenderers = Pick<
  ToolDefinition<any, any, any>,
  "renderCall" | "renderResult"
> & { renderShell?: "default" | "self" };
type RendererAPI = ExtensionAPI & {
  // Added in Pi 1.0.1. Keeping this optional preserves Bash support on older Pi releases.
  registerToolRenderer?: (
    resolver: (
      toolName: string,
      next: () => ToolRenderers | undefined,
    ) => ToolRenderers | undefined,
  ) => void;
};

function sourceFor(name: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = args as { command?: unknown; code?: unknown };
  if (name === "bash" && typeof value.command === "string")
    return value.command;
  if (name === "codemode" && typeof value.code === "string") return value.code;
  return undefined;
}

function toolList(tools: Set<SummaryTool>): string {
  const labels = [...tools].map((tool) =>
    tool === "bash" ? "Bash" : "codemode",
  );
  return labels.length === 2 ? `${labels[0]} and ${labels[1]}` : labels[0]!;
}

export default function plainToolSummaries(pi: ExtensionAPI): void {
  let summaries: Summaries | undefined;
  const summarizedTools = new Set<SummaryTool>();
  let backfilling: Summaries | undefined;
  let status = "Not initialized";
  let config: Config | undefined;
  const rendererAPI = pi as RendererAPI;
  const canWrapCodemode =
    typeof rendererAPI.registerToolRenderer === "function";
  const deferredRows = new Map<string, () => void>();
  let collectDeferredRows = true;
  const finishRendererBinding = () => {
    collectDeferredRows = false;
    const invalidations = [...deferredRows.values()];
    deferredRows.clear();
    if (!summaries) return;
    for (const invalidate of invalidations) invalidate();
  };
  rendererAPI.registerToolRenderer?.((toolName, next) => {
    const original = next();
    if (!original) return original;
    const tool = toolName as SummaryTool;
    if (tool !== "bash" && tool !== "codemode") return original;
    // After session_start Bash already has the compatibility wrapper registered
    // below. Before session_start (notably Pi's /reload transcript rebuild), keep
    // a lazy wrapper on each historical row so it can bind after state restores.
    if (tool === "bash" && summaries && summarizedTools.has("bash"))
      return original;
    if (
      tool === "bash" &&
      pi.getAllTools().find((candidate) => candidate.name === "bash")
        ?.sourceInfo.source !== "builtin"
    )
      return original;
    return withSummaryRenderers(
      original,
      tool,
      tool,
      () => (summarizedTools.has(tool) ? summaries : undefined),
      (id, invalidate) => {
        if (collectDeferredRows) deferredRows.set(`${tool}\0${id}`, invalidate);
      },
    );
  });
  const summaryModel = (ctx: ExtensionContext) =>
    config?.provider && config.model
      ? ctx.modelRegistry.find(config.provider, config.model)
      : ctx.model;

  pi.on("session_start", (_event, ctx) => {
    summaries?.dispose();
    summaries = undefined;
    config = undefined;
    summarizedTools.clear();
    if (ctx.mode !== "tui") {
      status = "Disabled outside interactive mode";
      finishRendererBinding();
      return;
    }
    // Use Pi's own merge, agent-directory resolution, and project-trust rules.
    const settings = SettingsManager.create(ctx.cwd, undefined, {
      projectTrusted: ctx.isProjectTrusted(),
    });
    try {
      config = configFromSettings(settings);
    } catch (error) {
      status = error instanceof Error ? error.message : "Invalid configuration";
      finishRendererBinding();
      return;
    }
    const activeTools = new Set(pi.getActiveTools());
    const issues: string[] = [];
    if (activeTools.has("bash")) {
      if (
        pi.getAllTools().find((t) => t.name === "bash")?.sourceInfo.source ===
        "builtin"
      )
        summarizedTools.add("bash");
      else issues.push("Skipped replacement Bash tool");
    }
    // MCP servers can activate codemode after session_start, so enable its
    // summary path whenever this Pi release can wrap the native renderer.
    if (canWrapCodemode) summarizedTools.add("codemode");
    else if (activeTools.has("codemode"))
      issues.push("Codemode summaries require Pi 1.0.1+");
    if (!summarizedTools.size) {
      status = issues[0] ?? "Bash and codemode are inactive";
      finishRendererBinding();
      return;
    }
    summaries = new Summaries(
      config,
      async () => {
        throw new Error("No summary model selected");
      },
      (record) => pi.appendEntry(summaryEntryType, record),
    );
    // Display records describe immutable calls, so they remain valid across tree navigation.
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === summaryEntryType)
        summaries.restore(entry.data);
    }
    if (summarizedTools.has("bash")) {
      const bash = createBashToolDefinition(ctx.cwd, {
        commandPrefix: settings.getShellCommandPrefix(),
        shellPath: settings.getShellPath(),
      });
      pi.registerTool(withSummary(bash, summaries));
    }
    status = `${toolList(summarizedTools)} summaries enabled${issues.length ? `; ${issues.join("; ")}` : ""}`;
    finishRendererBinding();
  });

  pi.on("tool_execution_start", (event, ctx) => {
    // Pi 1.0 nested calls have no transcript row to display a summary in.
    if (
      ("parentToolCallId" in event && event.parentToolCallId) ||
      !summarizedTools.has(event.toolName as SummaryTool) ||
      !summaries ||
      !config
    )
      return;
    const source = sourceFor(event.toolName, event.args);
    if (source === undefined || [...source].length < config.minCommandChars)
      return;
    const model = summaryModel(ctx);
    if (!model) {
      summaries.lastIssue =
        "Summary model unavailable; select a Pi model or check the explicit override";
      return;
    }
    const issue = reasoningIssue(model, config.reasoning);
    if (issue) {
      summaries.lastIssue = issue;
      return;
    }
    // Capture this call's model now: later /model changes affect only later tool calls.
    summaries.start(
      event.toolCallId,
      event.toolName,
      event.args,
      ctx.signal,
      createGenerate(
        ctx.modelRegistry,
        model,
        config.maxTokens,
        config.reasoning,
      ),
    );
  });
  pi.on("session_shutdown", () => summaries?.dispose());
  pi.registerCommand("tool-summaries", {
    description:
      "Show status, or backfill [count] [--force] recent messages (default 100)",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (args.trim()) {
        const match = /^backfill(?:\s+([1-9]\d*))?(?:\s+(--force))?$/.exec(
          args.trim(),
        );
        const count = Number(match?.[1] ?? 100);
        const force = match?.[2] === "--force";
        if (!match || !Number.isSafeInteger(count)) {
          ctx.ui.notify(
            "Usage: /tool-summaries [backfill [positive message count] [--force]]",
            "warning",
          );
          return;
        }
        const service = summaries;
        if (!summarizedTools.size || !service || !config) {
          ctx.ui.notify(`Cannot backfill: ${status}`, "warning");
          return;
        }
        if (backfilling === service) {
          ctx.ui.notify("A summary backfill is already running", "warning");
          return;
        }
        const model = summaryModel(ctx);
        const issue = model
          ? reasoningIssue(model, config.reasoning)
          : "Summary model unavailable";
        if (issue || !model) {
          ctx.ui.notify(issue ?? "Summary model unavailable", "warning");
          return;
        }
        const messages = ctx.sessionManager
          .getBranch()
          .filter((entry) => entry.type === "message")
          .slice(-count);
        const calls = messages
          .flatMap(({ message }) =>
            message.role === "assistant"
              ? message.content
                  .filter((part) => part.type === "toolCall")
                  .filter((part) =>
                    summarizedTools.has(part.name as SummaryTool),
                  )
              : [],
          )
          .filter((call) => {
            const source = sourceFor(call.name, call.arguments);
            return (
              typeof source === "string" &&
              [...source].length >= config!.minCommandChars
            );
          });
        const generate = createGenerate(
          ctx.modelRegistry,
          model,
          config.maxTokens,
          config.reasoning,
        );
        backfilling = service;
        ctx.ui.notify(
          `Backfilling ${calls.length} eligible tool calls from ${messages.length} messages${force ? "; regenerating existing summaries" : ""}…`,
          "info",
        );
        const totals = { generated: 0, skipped: 0, failed: 0 };
        try {
          // One queued request at a time leaves room for live summaries.
          for (const call of calls) {
            const result = await service.backfill(
              call.id,
              call.name,
              call.arguments,
              generate,
              force,
            );
            if (result === "cancelled" || summaries !== service) return;
            totals[result]++;
          }
          const storage = ctx.sessionManager.getSessionFile()
            ? "saved in the Pi session"
            : "memory only (ephemeral session)";
          ctx.ui.notify(
            `Backfill complete: ${totals.generated} generated, ${totals.skipped} already summarized, ${totals.failed} failed; ${storage}.${service.lastPersistenceIssue ? ` ${service.lastPersistenceIssue}` : ""}`,
            service.lastPersistenceIssue || totals.failed ? "warning" : "info",
          );
        } finally {
          if (backfilling === service) backfilling = undefined;
        }
        return;
      }
      const model = summaryModel(ctx);
      const selection = model
        ? `${model.provider}/${model.id}`
        : "no available model";
      const lines = [
        `Tool summaries: ${selection} (${config?.provider ? "override" : "current Pi model"}); reasoning: ${config?.reasoning ?? "provider default"}; ${status}`,
        `Storage: ${ctx.sessionManager.getSessionFile() ? "Pi session" : "memory only (ephemeral session)"}`,
      ];
      if (summaries?.lastPersistenceIssue)
        lines.push(summaries.lastPersistenceIssue);
      if (summaries?.lastIssue)
        lines.push(`Last fallback: ${summaries.lastIssue}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
