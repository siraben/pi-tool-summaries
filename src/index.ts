import {
  createBashToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { configFromSettings, type Config } from "./config.js";
import { Summaries } from "./summaries.js";
import { createGenerate } from "./provider.js";
import { withSummary } from "./renderer.js";

export default function plainToolSummaries(pi: ExtensionAPI): void {
  let summaries: Summaries | undefined;
  const registered = new Set<string>();
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
    registered.clear();
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
    summaries = new Summaries(config, async () => {
      throw new Error("No summary model selected");
    });

    const definitions = {
      bash: createBashToolDefinition(ctx.cwd, {
        commandPrefix: settings.getShellCommandPrefix(),
        shellPath: settings.getShellPath(),
      }),
      read: createReadToolDefinition(ctx.cwd, {
        autoResizeImages: settings.getImageAutoResize(),
      }),
      write: createWriteToolDefinition(ctx.cwd),
      edit: createEditToolDefinition(ctx.cwd),
      grep: createGrepToolDefinition(ctx.cwd),
      find: createFindToolDefinition(ctx.cwd),
      ls: createLsToolDefinition(ctx.cwd),
    };
    const active = new Set(pi.getActiveTools());
    const tools = pi.getAllTools();
    for (const name of config.tools) {
      // Do not enable disabled tools or overwrite sandbox/SSH/custom extension tools.
      if (
        !active.has(name) ||
        tools.find((t) => t.name === name)?.sourceInfo.source !== "builtin"
      )
        continue;
      pi.registerTool(withSummary(definitions[name], summaries));
      registered.add(name);
    }
    status = `tools: ${[...registered].join(", ") || "none"}`;
  });

  pi.on("tool_execution_start", (event, ctx) => {
    // Pi 1.0 nested calls have no transcript row to display a summary in.
    if (
      ("parentToolCallId" in event && event.parentToolCallId) ||
      !registered.has(event.toolName) ||
      !summaries ||
      !config
    )
      return;
    const model = summaryModel(ctx);
    if (!model) {
      summaries.lastIssue =
        "Summary model unavailable; select a Pi model or check the explicit override";
      return;
    }
    // Capture this call's model now: later /model changes affect only later tool calls.
    summaries.start(
      event.toolCallId,
      event.toolName,
      event.args,
      ctx.signal,
      createGenerate(ctx.modelRegistry, model, config.maxTokens),
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
      ctx.ui.notify(
        `Tool summaries: ${selection} (${config?.provider ? "override" : "current Pi model"}); ${status}${summaries?.lastIssue ? `\nLast fallback: ${summaries.lastIssue}` : ""}`,
        "info",
      );
    },
  });
}
