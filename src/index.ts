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
      "Show plain-language tool summary configuration and last fallback reason",
    handler: async (_args: string, ctx: ExtensionContext) => {
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
