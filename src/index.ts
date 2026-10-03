import {
  createBashToolDefinition,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { configFromSettings, type Config } from "./config.js";
import { Summaries } from "./summaries.js";
import { createGenerate, reasoningIssue } from "./provider.js";
import { withSummary } from "./renderer.js";

const summaryEntryType = "tool-summaries:summary";

export default function plainToolSummaries(pi: ExtensionAPI): void {
  let summaries: Summaries | undefined;
  let registered = false;
  let backfilling: Summaries | undefined;
  let status = "Not initialized";
  let config: Config | undefined;
  const summaryModel = (ctx: ExtensionContext) =>
    config?.provider && config.model
      ? ctx.modelRegistry.find(config.provider, config.model)
      : ctx.model;

  pi.on("session_start", (_event, ctx) => {
    summaries?.dispose();
    summaries = undefined;
    config = undefined;
    registered = false;
    if (ctx.mode !== "tui") {
      status = "Disabled outside interactive mode";
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
      return;
    }
    if (!pi.getActiveTools().includes("bash")) {
      status = "Bash is inactive";
      return;
    }
    if (
      pi.getAllTools().find((t) => t.name === "bash")?.sourceInfo.source !==
      "builtin"
    ) {
      status = "Skipped replacement Bash tool";
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
    const bash = createBashToolDefinition(ctx.cwd, {
      commandPrefix: settings.getShellCommandPrefix(),
      shellPath: settings.getShellPath(),
    });
    pi.registerTool(withSummary(bash, summaries));
    registered = true;
    status = "Bash summaries enabled";
  });

  pi.on("tool_execution_start", (event, ctx) => {
    // Pi 1.0 nested calls have no transcript row to display a summary in.
    if (
      ("parentToolCallId" in event && event.parentToolCallId) ||
      !registered ||
      event.toolName !== "bash" ||
      !summaries ||
      !config
    )
      return;
    const command = (event.args as { command?: unknown })?.command;
    if (
      typeof command !== "string" ||
      [...command].length < config.minCommandChars
    )
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
      "Show summary status, or backfill [count] recent messages (default 100)",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (args.trim()) {
        const match = /^backfill(?:\s+([1-9]\d*))?$/.exec(args.trim());
        const count = Number(match?.[1] ?? 100);
        if (!match || !Number.isSafeInteger(count)) {
          ctx.ui.notify(
            "Usage: /tool-summaries [backfill [positive message count]]",
            "warning",
          );
          return;
        }
        const service = summaries;
        if (!registered || !service || !config) {
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
                  .filter((part) => part.name === "bash")
              : [],
          )
          .filter((call) => {
            const command = call.arguments.command;
            return (
              typeof command === "string" &&
              [...command].length >= config!.minCommandChars
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
          `Backfilling ${calls.length} eligible Bash calls from ${messages.length} messages…`,
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
