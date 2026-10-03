import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";

const dist = dirname(
  fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
);
const { initTheme } = await import(
  pathToFileURL(join(dist, "modes/interactive/theme/theme.js")).href
);
const { ToolExecutionComponent } = await import(
  pathToFileURL(join(dist, "modes/interactive/components/tool-execution.js"))
    .href
);
initTheme("dark", false);

test(
  "real Pi events start a summary alongside Bash and refresh its row before Bash ends",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-summary-concurrency-"));
    await writeFile(
      join(root, "settings.json"),
      JSON.stringify({ toolSummaries: { minCommandChars: 0 } }),
    );
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const times: Record<string, number> = {};
    const errors: string[] = [];
    const summary =
      "Printing a start marker, waiting for a release file, and printing a finish marker.";
    let shellStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      shellStarted = resolve;
    });
    let row: any;
    let session:
      Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let prompt: Promise<unknown> | undefined;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      const isSummary = JSON.stringify(input.messages[0]).includes(
        "supplied JSON data",
      );
      if (isSummary) {
        times.summaryRequest = performance.now();
        await started;
        await delay(20);
        times.summaryResponse = performance.now();
      }
      const hasResult = input.messages.some((m: any) => m.role === "tool");
      const toolCall = !isSummary && !hasResult;
      const delta = toolCall
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "controlled-bash",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({
                    command:
                      "printf started; sleep 0.5; while [ ! -f release ]; do sleep 0.02; done; printf finished",
                    timeout: 5,
                  }),
                },
              },
            ],
          }
        : { role: "assistant", content: isSummary ? summary : "Done." };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const choice of [
        { index: 0, delta, finish_reason: null },
        {
          index: 0,
          delta: {},
          finish_reason: toolCall ? "tool_calls" : "stop",
        },
      ])
        response.write(
          `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 0, model: "local", choices: [choice] })}\n\n`,
        );
      response.end("data: [DONE]\n\n");
    });
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const runtime = await ModelRuntime.create({
        authPath: join(root, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(root, "catalog.json"),
        allowModelNetwork: false,
      });
      runtime.registerProvider("concurrency-test", {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: "openai-completions",
        apiKey: "local-test-only",
        models: [
          {
            id: "local",
            name: "Local",
            reasoning: false,
            input: ["text"],
            contextWindow: 32768,
            maxTokens: 512,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      });
      const settingsManager = SettingsManager.inMemory({
        retry: { enabled: false },
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [extension],
      });
      await resourceLoader.reload();
      ({ session } = await createAgentSession({
        cwd: root,
        agentDir: root,
        modelRuntime: runtime,
        model: new ModelRegistry(runtime).find("concurrency-test", "local"),
        thinkingLevel: "off",
        tools: ["bash"],
        settingsManager,
        resourceLoader,
        sessionManager: SessionManager.inMemory(root),
      }));
      await session.bindExtensions({
        mode: "tui",
        onError: (e) => {
          errors.push(e.error);
        },
      });
      const ui = {
        requestRender() {
          if (
            row &&
            !times.summaryVisible &&
            row.render(200).join("\n").includes(summary)
          ) {
            times.summaryVisible = performance.now();
            void writeFile(join(root, "release"), "");
          }
        },
      };
      session.subscribe((event) => {
        if (event.type === "tool_execution_start") {
          times.toolStart = performance.now();
          row = new ToolExecutionComponent(
            "bash",
            event.toolCallId,
            event.args,
            {},
            session!.extensionRunner.getToolDefinition("bash"),
            ui,
            root,
          );
          row.markExecutionStarted();
        }
        if (event.type === "tool_execution_update") {
          times.shellOutput ??= performance.now();
          shellStarted();
          row.updateResult({ ...event.partialResult, isError: false }, true);
        }
        if (event.type === "tool_execution_end") {
          times.toolEnd = performance.now();
          row.updateResult({ ...event.result, isError: event.isError });
        }
      });
      prompt = session.prompt("Run the controlled Bash test.");
      await prompt;
      assert.deepEqual(errors, []);
      assert.ok(times.summaryRequest < times.toolEnd, JSON.stringify(times));
      assert.ok(
        times.shellOutput < times.summaryResponse,
        JSON.stringify(times),
      );
      assert.ok(times.summaryVisible < times.toolEnd, JSON.stringify(times));
      assert.match(row.render(200).join("\n"), /startedfinished/);
      t.diagnostic(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(times).map(([key, value]) => [
              key,
              Math.round(value - times.toolStart),
            ]),
          ),
        ),
      );
    } finally {
      await writeFile(join(root, "release"), "");
      shellStarted();
      await session?.abort();
      await prompt?.catch(() => {});
      session?.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
);
