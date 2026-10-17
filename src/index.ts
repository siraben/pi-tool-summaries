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
import { authenticationIssue, Requests } from "./requests.js";

const summaryEntryType = "tool-summaries:summary";
type SummaryTool = "bash" | "powershell" | "codemode";
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
  if (
    (name === "bash" || name === "powershell") &&
    typeof value.command === "string"
  )
    return value.command;
  if (name === "codemode" && typeof value.code === "string") return value.code;
  return undefined;
}

function toolList(tools: Set<SummaryTool>): string {
  const labels = [...tools].map((tool) =>
    tool === "bash" ? "Bash" : tool === "powershell" ? "PowerShell" : tool,
  );
  return labels.length > 1
    ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`
    : labels[0]!;
}

export default function plainToolSummaries(pi: ExtensionAPI): void {
  let summaries: Summaries | undefined;
  const summarizedTools = new Set<SummaryTool>();
  let backfilling: Summaries | undefined;
  let backfillAbort: AbortController | undefined;
  let status = "Not initialized";
  let config: Config | undefined;
  let requests = new Requests();
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
    if (tool !== "bash" && tool !== "powershell" && tool !== "codemode")
      return original;
    // After session_start Bash already has the compatibility wrapper registered
    // below. Before session_start (notably Pi's /reload transcript rebuild), keep
    // a lazy wrapper on each historical row so it can bind after state restores.
    if (tool === "bash" && summaries && summarizedTools.has("bash"))
      return original;
    if (
      (tool === "bash" || tool === "powershell") &&
      pi.getAllTools().find((candidate) => candidate.name === tool)?.sourceInfo
        .source !== "builtin"
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

  const requestKey = (model: NonNullable<ExtensionContext["model"]>) =>
    `${model.provider}/${model.id}`;
  const generateFor = (
    ctx: ExtensionContext,
    model: NonNullable<ExtensionContext["model"]>,
  ) => {
    const service = requests;
    return service.wrap(
      requestKey(model),
      createGenerate(
        ctx.modelRegistry,
        model,
        config!.maxTokens,
        config!.reasoning,
        (usage) => service.recordUsage(usage),
      ),
      (signal) => authenticationIssue(ctx.modelRegistry, model, signal),
      (text) => ctx.ui.notify(text, "warning"),
    );
  };

  pi.on("session_start", (_event, ctx) => {
    backfillAbort?.abort();
    backfillAbort = undefined;
    summaries?.dispose();
    requests = new Requests();
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
      requests.maxRequests = config.maxRequests;
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
    // Wrap native PowerShell in place: never recreate its execution/configuration.
    if (activeTools.has("powershell")) {
      if (!canWrapCodemode)
        issues.push("PowerShell summaries require Pi 1.0.1+");
      else if (
        pi.getAllTools().find((tool) => tool.name === "powershell")?.sourceInfo
          .source === "builtin"
      )
        summarizedTools.add("powershell");
      else issues.push("Skipped replacement PowerShell tool");
    }
    // MCP servers can activate codemode after session_start, so enable its
    // summary path whenever this Pi release can wrap the native renderer.
    if (canWrapCodemode) summarizedTools.add("codemode");
    else if (activeTools.has("codemode"))
      issues.push("Codemode summaries require Pi 1.0.1+");
    if (!summarizedTools.size) {
      status = issues[0] ?? "Bash, PowerShell and codemode are inactive";
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
      !config?.enabled
    )
      return;
    const source = sourceFor(event.toolName, event.args);
    if (source === undefined || [...source].length < config.minCommandChars)
      return;
    const model = summaryModel(ctx);
    if (!model) {
      summaries.lastIssue =
        config.modelSource === "current"
          ? "Summary model unavailable; select a Pi model"
          : "Summary model unavailable; check the summary model and provider authentication";
      requests.warnOnce(
        `missing:${config.provider ?? "current"}/${config.model ?? "current"}`,
        summaries.lastIssue,
        (text) => ctx.ui.notify(text, "warning"),
      );
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
      generateFor(ctx, model),
    );
  });
  pi.on("session_shutdown", () => {
    backfillAbort?.abort();
    summaries?.dispose();
  });
  pi.registerCommand("tool-summaries", {
    description:
      "Status/usage, on/off/toggle, retry, cancel, or backfill [count] [--force]",
    handler: async (args: string, ctx: ExtensionContext) => {
      const action = args.trim();
      if (action === "cancel") {
        backfillAbort?.abort();
        ctx.ui.notify(
          backfillAbort
            ? "Backfill cancelled; live summaries are unaffected"
            : "No backfill is running",
          "info",
        );
        return;
      }
      if (["on", "off", "toggle"].includes(action)) {
        if (!config || !summaries) {
          ctx.ui.notify(`Cannot change summaries: ${status}`, "warning");
          return;
        }
        config.enabled =
          action === "toggle" ? !config.enabled : action === "on";
        if (!config.enabled) {
          backfillAbort?.abort();
          summaries.cancelAll();
        }
        ctx.ui.notify(
          `Summary requests ${config.enabled ? "enabled" : "paused"} for this runtime session; saved summaries remain visible`,
          "info",
        );
        return;
      }
      if (args.trim() === "retry") {
        requests.reset();
        ctx.ui.notify(
          "Summary cooldowns reset; the next eligible call will recheck authentication",
          "info",
        );
        return;
      }
      if (args.trim()) {
        const match = /^backfill(?:\s+([1-9]\d*))?(?:\s+(--force))?$/.exec(
          args.trim(),
        );
        const count = Number(match?.[1] ?? 100);
        const force = match?.[2] === "--force";
        if (!match || !Number.isSafeInteger(count)) {
          ctx.ui.notify(
            "Usage: /tool-summaries [on|off|toggle|retry|cancel|backfill [positive message count] [--force]]",
            "warning",
          );
          return;
        }
        const service = summaries;
        if (!summarizedTools.size || !service || !config?.enabled) {
          ctx.ui.notify(
            `Cannot backfill: ${config?.enabled === false ? "summary requests paused" : status}`,
            "warning",
          );
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
        const generate = generateFor(ctx, model);
        backfilling = service;
        const controller = new AbortController();
        backfillAbort = controller;
        ctx.ui.notify(
          `Backfilling ${calls.length} eligible tool calls from ${messages.length} messages${force ? "; regenerating existing summaries" : ""}…`,
          "info",
        );
        const totals = { generated: 0, skipped: 0, failed: 0 };
        let stopped: string | undefined;
        try {
          // One queued request at a time leaves room for live summaries.
          for (const call of calls) {
            const result = await service.backfill(
              call.id,
              call.name,
              call.arguments,
              generate,
              force,
              controller.signal,
            );
            if (result === "cancelled" || summaries !== service) return;
            totals[result]++;
            if (
              result === "failed" &&
              (stopped = requests.status(requestKey(model)))
            )
              break;
          }
          const storage = ctx.sessionManager.getSessionFile()
            ? "saved in the Pi session"
            : "memory only (ephemeral session)";
          ctx.ui.notify(
            `Backfill complete: ${totals.generated} generated, ${totals.skipped} already summarized, ${totals.failed} failed; ${storage}.${stopped ? ` Stopped: ${stopped}.` : ""}${service.lastPersistenceIssue ? ` ${service.lastPersistenceIssue}` : ""}`,
            service.lastPersistenceIssue || totals.failed ? "warning" : "info",
          );
        } finally {
          if (backfilling === service) backfilling = undefined;
          if (backfillAbort === controller) backfillAbort = undefined;
        }
        return;
      }
      const currentRequests = requests;
      const currentSummaries = summaries;
      const model = summaryModel(ctx);
      const selection = model
        ? `${model.provider}/${model.id}`
        : "no available model";
      const modelSource =
        config?.modelSource === "current"
          ? "current Pi model"
          : config?.modelSource === "configured"
            ? "configured override"
            : "default";
      const lines = [
        `Tool summaries: ${selection} (${modelSource}); reasoning: ${config?.reasoning ?? "provider default"}; ${status}`,
        `Requests: ${config?.enabled ? "enabled" : "paused"}; exclusions: ${config?.exclude.length ?? 0}`,
        `Storage: ${ctx.sessionManager.getSessionFile() ? "Pi session" : "memory only (ephemeral session)"}`,
      ];
      const stats = requests.stats;
      lines.push(
        `Runtime-session usage: ${stats.requests}/${config?.maxRequests || "unlimited"} generation attempts; usage reported for ${stats.responsesWithUsage} responses`,
        `Reported tokens: input ${stats.input}, output ${stats.output}, cache read ${stats.cacheRead}, cache write ${stats.cacheWrite}`,
        `Reported estimated cost: $${stats.estimatedCost.toFixed(6)} USD (${stats.responsesWithCost} responses with pricing; not a billing total)`,
      );
      if (!config?.enabled) {
        lines.push("Readiness: paused; no requests will be generated");
      } else if (model && summarizedTools.size && config) {
        const issue =
          reasoningIssue(model, config.reasoning) ??
          requests.status(requestKey(model)) ??
          (await authenticationIssue(
            ctx.modelRegistry,
            model,
            AbortSignal.timeout(config.timeoutMs),
          ));
        lines.push(
          `Readiness: ${issue ?? "credentials resolved; model access, credits and endpoint availability are checked on request"}`,
        );
      } else {
        lines.push("Readiness: unavailable (no active summary tools or model)");
      }
      if (summaries?.lastPersistenceIssue)
        lines.push(summaries.lastPersistenceIssue);
      if (summaries?.lastIssue)
        lines.push(`Last fallback: ${summaries.lastIssue}`);
      if (requests !== currentRequests || summaries !== currentSummaries)
        return;
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
