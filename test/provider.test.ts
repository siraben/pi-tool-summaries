import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createGenerate, providerDefaults } from "../src/provider.js";

// One local endpoint checks the real Pi authentication/transport path, without paid calls.
test("Pi sends the selected model and credentials and reports usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-provider-test-"));
  let received: any, authorization: string | undefined;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    received = JSON.parse(body);
    authorization = request.headers.authorization;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const chunk of [
      {
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Reading files." },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      },
    ])
      response.write(
        `data: ${JSON.stringify({ id: "test", model: "small", ...chunk })}\n\n`,
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
      modelsStorePath: join(root, "models.json"),
      allowModelNetwork: false,
    });
    runtime.registerProvider("local", {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      api: "openai-completions",
      apiKey: "test-key",
      models: [
        {
          id: "small",
          name: "Small",
          reasoning: true,
          thinkingLevelMap: { off: "none" },
          compat: { thinkingFormat: "openrouter" },
          input: ["text"],
          contextWindow: 32768,
          maxTokens: 512,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    const registry = new ModelRegistry(runtime);
    const model = registry.find("local", "small");
    assert.ok(model);
    let tokens = 0;
    const generate = createGenerate(
      registry,
      model,
      220,
      undefined,
      (usage) => {
        tokens += usage?.input ?? 0;
      },
    );
    assert.equal(
      await generate("input data", new AbortController().signal),
      "Reading files.",
    );
    assert.equal(authorization, "Bearer test-key");
    assert.equal(received.model, "small");
    assert.equal(received.messages.at(-1).content[0].text, "input data");
    assert.equal(received.reasoning, undefined);
    assert.equal(tokens, 20);
    await createGenerate(
      registry,
      model,
      220,
      "off",
    )("input data", new AbortController().signal);
    assert.equal(received.reasoning.effort, "none");
    await assert.rejects(
      createGenerate(
        registry,
        model,
        220,
        "max",
      )("input", new AbortController().signal),
      /does not support/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("provider failures remain safe and incomplete responses are rejected", async () => {
  for (const [stopReason, expected] of [
    ["error", /HTTP 401/],
    ["length", /token limit/],
    ["aborted", /cancelled/],
  ] as const) {
    const generate = createGenerate(
      {
        complete: async () => ({
          stopReason,
          errorMessage: "401 Bearer secret",
          content: [],
        }),
      } as any,
      {} as any,
      220,
    );
    await assert.rejects(
      generate("input", new AbortController().signal),
      (error: Error) => {
        assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /secret/);
        return true;
      },
    );
  }
});

test("provider defaults remove implicit reasoning controls and preserve explicit defaults", () => {
  const model = { api: "openai-completions", samplingParams: {} } as any;
  assert.equal(
    (providerDefaults({ reasoning: { effort: "none" } }, model) as any)
      .reasoning,
    undefined,
  );
  model.samplingParams = { reasoning: { effort: "low" } };
  assert.equal((providerDefaults({}, model) as any).reasoning.effort, "low");
});
