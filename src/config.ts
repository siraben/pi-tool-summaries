export const toolNames = [
  "bash",
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;
export type SummaryTool = (typeof toolNames)[number];
export interface Config {
  provider?: string;
  model?: string;
  tools: SummaryTool[];
  timeoutMs: number;
  maxInputChars: number;
  maxTokens: number;
  concurrency: number;
}

export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
  modelOverride?: string,
): Config {
  const integer = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const raw = env[`PI_TOOL_SUMMARY_${name}`];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new Error(
        `PI_TOOL_SUMMARY_${name} must be an integer from ${min} to ${max}`,
      );
    }
    return n;
  };
  const tools = (
    env.PI_TOOL_SUMMARY_TOOLS ?? "bash,read,edit,write,grep,find,ls"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (tools.some((t) => !toolNames.includes(t as SummaryTool))) {
    throw new Error(
      `PI_TOOL_SUMMARY_TOOLS must contain only: ${toolNames.join(", ")}`,
    );
  }
  let provider = env.PI_TOOL_SUMMARY_PROVIDER?.trim() || undefined;
  let model = env.PI_TOOL_SUMMARY_MODEL?.trim() || undefined;
  if (modelOverride !== undefined) {
    const ref = modelOverride.trim();
    if (ref === "current") {
      provider = undefined;
      model = undefined;
    } else {
      const slash = ref.indexOf("/");
      if (slash < 1 || slash === ref.length - 1) {
        throw new Error(
          "--tool-summary-model must be current or provider/model-id",
        );
      }
      provider = ref.slice(0, slash);
      model = ref.slice(slash + 1);
    }
  }
  if (Boolean(provider) !== Boolean(model))
    throw new Error(
      "Set both PI_TOOL_SUMMARY_PROVIDER and PI_TOOL_SUMMARY_MODEL",
    );
  return {
    provider,
    model,
    tools: [...new Set(tools)] as SummaryTool[],
    timeoutMs: integer("TIMEOUT_MS", 8000, 100, 60000),
    maxInputChars: integer("MAX_INPUT_CHARS", 24000, 100, 200000),
    maxTokens: integer("MAX_TOKENS", 220, 64, 1000),
    concurrency: integer("CONCURRENCY", 2, 1, 8),
  };
}
