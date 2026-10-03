import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createGenerate, providerDefaults } from "../src/provider.js";

test("Pi routes a summary through its native provider and authentication pipeline", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-provider-test-"));
  let requests = 0;
  let received: { authorization?: string; body: any } | undefined;
  const summary = "I’ll read the source files and print their paths.";
  const server = createServer(async (request, response) => {
    requests++;
    let body = "";
    for await (const part of request) body += part;
    received = {
      authorization: request.headers.authorization,
      body: JSON.parse(body),
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const chunk of [
      {
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: summary },
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
        `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 0, model: "local-summary", ...chunk })}\n\n`,
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
    runtime.registerProvider("summary-test", {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      api: "openai-completions",
      apiKey: "local-test-only",
      models: [
        {
          id: "local-summary",
          name: "Local summary test",
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
    const model = registry.find("summary-test", "local-summary");
    assert.ok(model);
    const input = JSON.stringify({
      tool: "bash",
      arguments: { command: "find src -type f" },
    });
    const result = await createGenerate(
      registry,
      model,
      220,
    )(input, AbortSignal.timeout(5000));
    assert.equal(result, summary);
    assert.equal(received?.authorization, "Bearer local-test-only");
    assert.equal(received?.body.model, "local-summary");
    assert.deepEqual(received?.body.messages.at(-1).content, [
      { type: "text", text: input },
    ]);
    assert.equal(received?.body.tools, undefined);
    assert.equal(received?.body.reasoning, undefined);
    assert.equal(received?.body.reasoning_effort, undefined);
    for (const variant of [
      { ...model, thinkingLevelMap: { off: null } },
      {
        ...model,
        compat: { ...model.compat, thinkingFormat: "qwen" as const },
      },
      {
        ...model,
        compat: {
          ...model.compat,
          thinkingFormat: "qwen-chat-template" as const,
        },
      },
      {
        ...model,
        compat: {
          ...model.compat,
          thinkingFormat: "openai" as const,
          supportsReasoningEffort: true,
        },
      },
    ]) {
      assert.equal(
        await createGenerate(
          registry,
          variant,
          220,
        )(input, AbortSignal.timeout(5000)),
        summary,
      );
      assert.equal(received?.body.reasoning, undefined);
      assert.equal(received?.body.reasoning_effort, undefined);
      assert.equal(received?.body.enable_thinking, undefined);
      assert.equal(received?.body.chat_template_kwargs, undefined);
    }
    assert.equal(
      await createGenerate(
        registry,
        { ...model, samplingParams: { reasoning: { effort: "high" } } },
        220,
      )(input, AbortSignal.timeout(5000)),
      summary,
    );
    assert.deepEqual(received?.body.reasoning, { effort: "high" });
    for (const reasoning of ["low", "off"] as const) {
      assert.equal(
        await createGenerate(
          registry,
          { ...model, samplingParams: { reasoning: { effort: "high" } } },
          220,
          reasoning,
        )(input, AbortSignal.timeout(5000)),
        summary,
      );
      assert.deepEqual(received?.body.reasoning, {
        effort: reasoning === "off" ? "none" : reasoning,
      });
    }
    const beforeUnsupported = requests;
    await assert.rejects(
      createGenerate(
        registry,
        { ...model, thinkingLevelMap: { off: null } },
        220,
        "off",
      )(input, AbortSignal.timeout(5000)),
      /does not support reasoning level off/,
    );
    await assert.rejects(
      createGenerate(
        registry,
        model,
        220,
        "max",
      )(input, AbortSignal.timeout(5000)),
      /does not support reasoning level max/,
    );
    assert.equal(requests, beforeUnsupported);
    assert.equal(
      received?.body.max_tokens ?? received?.body.max_completion_tokens,
      220,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("provider defaults preserve explicit model settings and non-OpenAI adapter behavior", () => {
  const model = {
    api: "openai-responses",
    samplingParams: {},
    compat: {},
  } as Parameters<typeof providerDefaults>[1];
  const payload = {
    model: "example",
    reasoning: { effort: "none" },
    max_output_tokens: 220,
  };
  assert.deepEqual(providerDefaults(payload, model), {
    model: "example",
    max_output_tokens: 220,
  });
  assert.deepEqual(
    payload.reasoning,
    { effort: "none" },
    "Do not mutate the adapter's input",
  );
  assert.equal(
    providerDefaults(payload, { ...model, api: "anthropic-messages" }),
    payload,
  );
  assert.deepEqual(
    providerDefaults(
      {
        chat_template_kwargs: {
          enable_thinking: false,
          custom_thinking: false,
          keep: "literal",
        },
      },
      {
        ...model,
        api: "openai-completions",
        compat: {
          thinkingFormat: "chat-template",
          chatTemplateKwargs: {
            custom_thinking: { $var: "thinking.enabled" },
            keep: "literal",
          },
        },
      },
    ),
    { chat_template_kwargs: { keep: "literal" } },
  );
});
