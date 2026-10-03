import { SummaryFailure, providerFailure } from "./failures.js";
import { randomUUID } from "node:crypto";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ReasoningLevel } from "./config.js";
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

/** Match Pi's supported-level rules rather than letting its adapter silently clamp. */
export function reasoningIssue(
  model: SummaryModel,
  reasoning?: ReasoningLevel,
): string | undefined {
  if (reasoning === undefined) return;
  if (
    (!model.reasoning && reasoning !== "off") ||
    model.thinkingLevelMap?.[reasoning] === null ||
    ((reasoning === "xhigh" || reasoning === "max") &&
      model.thinkingLevelMap?.[reasoning] === undefined)
  )
    return `Summary model does not support reasoning level ${reasoning}`;
}

/** Reuse Pi's provider, authentication, endpoint, and transport integration. */
export function createGenerate(
  registry: ModelRegistry,
  model: SummaryModel,
  maxTokens: number,
  reasoning?: ReasoningLevel,
): Generate {
  return async (input, signal) => {
    const issue = reasoningIssue(model, reasoning);
    if (issue) throw new Error(issue);
    const context = {
      systemPrompt: summaryPrompt,
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: input }],
          timestamp: Date.now(),
        },
      ],
    };
    const options = {
      signal,
      maxTokens,
      cacheRetention: "none" as const,
      sessionId: randomUUID(),
    };
    let response;
    try {
      if (reasoning === undefined) {
        // Raw completion plus the payload hook preserves provider defaults, not implicit off.
        response = await registry.complete(model, context, {
          ...options,
          onPayload: providerDefaults,
        });
      } else {
        // Explicit levels use Pi's provider-neutral API. Do not let model sampling defaults
        // overwrite the requested level at the end of request construction.
        const samplingParams = { ...model.samplingParams };
        for (const key of [
          "reasoning",
          "reasoning_effort",
          "thinking",
          "enable_thinking",
          "chat_template_kwargs",
          "chat_template_args",
        ])
          delete samplingParams[key];
        const selected = { ...model, samplingParams };
        const simpleOptions = {
          ...options,
          reasoning: reasoning === "off" ? undefined : reasoning,
        };
        type Provider = NonNullable<ReturnType<ModelRegistry["getProvider"]>>;
        const simpleRegistry = registry as ModelRegistry & {
          streamSimple?: Provider["streamSimple"];
        };
        if (simpleRegistry.streamSimple) {
          response = await simpleRegistry
            .streamSimple(selected, context, simpleOptions)
            .result();
        } else {
          // Pre-1.0 exposes provider dispatch and request-time authentication separately.
          const provider = registry.getProvider(selected.provider);
          const auth = await registry.getApiKeyAndHeaders(selected);
          if (!provider || !auth.ok)
            throw new SummaryFailure("Provider/authentication unavailable");
          signal.throwIfAborted();
          response = await provider
            .streamSimple(
              auth.baseUrl ? { ...selected, baseUrl: auth.baseUrl } : selected,
              context as unknown as Parameters<typeof provider.streamSimple>[1],
              {
                ...simpleOptions,
                apiKey: auth.apiKey,
                headers: auth.headers,
                env: auth.env,
              },
            )
            .result();
        }
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof SummaryFailure) throw error;
      if (error instanceof Error && error.name === "AbortError")
        throw new SummaryFailure("Summary cancelled by provider", error);
      throw providerFailure(error);
    }
    if (signal.aborted) throw signal.reason;
    if (response.stopReason === "error") throw providerFailure(response);
    if (response.stopReason === "aborted")
      throw new SummaryFailure("Summary cancelled by provider", response);
    if (response.stopReason === "length")
      throw new SummaryFailure(
        "Summary response reached the output token limit",
        response,
      );
    return response.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  };
}
