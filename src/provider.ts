import { randomUUID } from "node:crypto";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Generate } from "./summaries.js";
import { summaryPrompt } from "./summaries.js";

type SummaryModel = NonNullable<ReturnType<ModelRegistry["find"]>>;

/** Remove Pi's implicit off controls, preserving explicit model sampling defaults. */
export function providerDefaults(
  payload: unknown,
  model: SummaryModel,
): unknown {
  if (!model.api.includes("openai") || !payload || typeof payload !== "object")
    return payload;
  const body = { ...payload } as Record<string, unknown>;
  const defaults = model.samplingParams ?? {};
  for (const key of [
    "reasoning",
    "reasoning_effort",
    "thinking",
    "enable_thinking",
  ]) {
    if (Object.hasOwn(defaults, key)) body[key] = defaults[key];
    else delete body[key];
  }
  const compat = model.compat as
    | {
        chatTemplateKwargs?: Record<string, unknown>;
        chatTemplateArgs?: Record<string, unknown>;
      }
    | undefined;
  for (const [field, template] of [
    ["chat_template_kwargs", compat?.chatTemplateKwargs],
    ["chat_template_args", compat?.chatTemplateArgs],
  ] as const) {
    if (Object.hasOwn(defaults, field)) {
      body[field] = defaults[field];
      continue;
    }
    const value = body[field];
    if (!value || typeof value !== "object") continue;
    const kwargs = { ...value } as Record<string, unknown>;
    for (const key of ["enable_thinking", "preserve_thinking"]) {
      if (!Object.hasOwn(template ?? {}, key)) delete kwargs[key];
    }
    for (const [key, value] of Object.entries(template ?? {})) {
      if (value && typeof value === "object" && "$var" in value)
        delete kwargs[key];
    }
    if (Object.keys(kwargs).length) body[field] = kwargs;
    else delete body[field];
  }
  return body;
}

/** Reuse Pi's provider, authentication, endpoint, and transport integration. */
export function createGenerate(
  registry: ModelRegistry,
  model: SummaryModel,
  maxTokens: number,
): Generate {
  return async (input, signal) => {
    // Raw completion leaves reasoning unspecified. OpenAI-compatible adapters still
    // synthesize off controls, so use Pi's payload hook to leave those to the server.
    const response = await registry.complete(
      model,
      {
        systemPrompt: summaryPrompt,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: input }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        signal,
        maxTokens,
        cacheRetention: "none",
        sessionId: randomUUID(),
        onPayload: providerDefaults,
      },
    );
    if (["error", "aborted", "length"].includes(response.stopReason))
      throw new Error("Incomplete summary");
    return response.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  };
}
