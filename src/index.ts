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
import { Requests } from "./requests.js";

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
  const eligibleTool = (name: string) =>
    summarizedTools.has(name as SummaryTool) &&
    (name === "codemode" ||
      (name === "bash" && !canWrapRenderers) ||
      pi.getAllTools().find((tool) => tool.name === name)?.sourceInfo.source ===
        "builtin");
  let backfilling: Summaries | undefined;
  let status = "Not initialized";
  let config: Config | undefined;
  let requests = new Requests();
  const rendererAPI = pi as RendererAPI;
  const canWrapRenderers =
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
    // Historical rows can be built before session_start restores saved summaries.
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
      (text) => ctx.ui.notify(text, "warning"),
    );
  };

  pi.on("session_start", (_event, ctx) => {
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
    // Wrap native PowerShell in place, including activation after session_start.
    const powerShellSource = pi
      .getAllTools()
      .find((tool) => tool.name === "powershell")?.sourceInfo.source;
    if (activeTools.has("powershell") || powerShellSource === "builtin") {
      if (!canWrapRenderers)
        issues.push("PowerShell summaries require Pi 1.0.1+");
      else if (powerShellSource === "builtin")
        summarizedTools.add("powershell");
      else issues.push("Skipped replacement PowerShell tool");
    }
    // MCP servers can activate codemode after session_start, so enable its
    // summary path whenever this Pi release can wrap the native renderer.
    if (canWrapRenderers) summarizedTools.add("codemode");
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
    if (summarizedTools.has("bash") && !canWrapRenderers) {
      const commandPrefix = settings.getShellCommandPrefix();
      const shellPath = settings.getShellPath();
      const bash = createBashToolDefinition(ctx.cwd, {
        ...(commandPrefix === undefined ? {} : { commandPrefix }),
        ...(shellPath === undefined ? {} : { shellPath }),
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
      !eligibleTool(event.toolName) ||
      !summaries ||
      !config?.enabled
    )
      return;
    const source = sourceFor(event.toolName, event.args);
    if (source === undefined || [...source].length < config.minCommandChars)
      return;
    const model = summaryModel(ctx);
    if (!model) {
      summaries.lastIssue = !config.provider
        ? "Summary model unavailable; select a Pi model"
        : "Summary model unavailable; check the summary model and provider authentication";
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
  pi.on("session_shutdown", () => summaries?.dispose());
  pi.registerCommand("tool-summaries", {
    description: "Status/usage, on/off/toggle, or backfill [count] [--force]",
    handler: async (args: string, ctx: ExtensionContext) => {
      const action = args.trim();
      if (["on", "off", "toggle"].includes(action)) {
        if (!config || !summaries) {
          ctx.ui.notify(`Cannot change summaries: ${status}`, "warning");
          return;
        }
        config.enabled =
          action === "toggle" ? !config.enabled : action === "on";
        if (!config.enabled) summaries.cancelAll();
        ctx.ui.notify(
          `Summary requests ${config.enabled ? "enabled" : "paused"} for this runtime session; saved summaries remain visible`,
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
            "Usage: /tool-summaries [on|off|toggle|backfill [positive message count] [--force]]",
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
                  .filter((part) => eligibleTool(part.name))
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
            );
            if (result === "cancelled" || summaries !== service) return;
            totals[result]++;
            if (
              result === "failed" &&
              requests.coolingDown(requestKey(model))
            ) {
              stopped = "summary model cooling down";
              break;
            }
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
        }
        return;
      }
      const model = summaryModel(ctx);
      const selection = model
        ? `${model.provider}/${model.id}`
        : "no available model";
      const modelSource = config?.provider
        ? "configured override"
        : "current Pi model";
      const lines = [
        `Tool summaries: ${selection} (${modelSource}); reasoning: ${config?.reasoning ?? "provider default"}; ${status}`,
        `Requests: ${config?.enabled ? "enabled" : "paused"}`,
        `Storage: ${ctx.sessionManager.getSessionFile() ? "Pi session" : "memory only (ephemeral session)"}`,
      ];
      const stats = requests.stats;
      lines.push(
        `Usage: ${stats.requests} generation attempts; usage reported for ${stats.reported} responses`,
        `Reported tokens: input ${stats.input}, output ${stats.output}, cache read ${stats.cacheRead}, cache write ${stats.cacheWrite}`,
        `Estimated cost: $${stats.cost.toFixed(6)} USD (provider-reported, not a billing total)`,
      );
      if (summaries?.lastPersistenceIssue)
        lines.push(summaries.lastPersistenceIssue);
      if (summaries?.lastIssue)
        lines.push(`Last fallback: ${summaries.lastIssue}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
