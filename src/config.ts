import type { SettingsManager } from "@earendil-works/pi-coding-agent";

export interface Config {
  provider?: string;
  model?: string;
  timeoutMs: number;
  maxInputChars: number;
  maxTokens: number;
  concurrency: number;
}

/** Parse the toolSummaries namespace from Pi's effective settings. */
export function readConfig(settings: { toolSummaries?: unknown } = {}): Config {
  const raw =
    settings.toolSummaries === undefined ? {} : settings.toolSummaries;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("toolSummaries must be an object");
  const value = raw as Record<string, unknown>;
  const allowed = [
    "model",
    "timeoutMs",
    "maxInputChars",
    "maxTokens",
    "concurrency",
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Unknown toolSummaries setting");
  const integer = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const n = value[name] ?? fallback;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max)
      throw new Error(
        `toolSummaries.${name} must be an integer from ${min} to ${max}`,
      );
    return n;
  };
  let provider: string | undefined;
  let model: string | undefined;
  if (value.model !== undefined && value.model !== "current") {
    if (typeof value.model !== "string")
      throw new Error(
        "toolSummaries.model must be current or provider/model-id",
      );
    const ref = value.model.trim();
    const slash = ref.indexOf("/");
    if (slash < 1 || slash === ref.length - 1)
      throw new Error(
        "toolSummaries.model must be current or provider/model-id",
      );
    provider = ref.slice(0, slash);
    model = ref.slice(slash + 1);
  }
  return {
    provider,
    model,
    timeoutMs: integer("timeoutMs", 8000, 100, 60000),
    maxInputChars: integer("maxInputChars", 24000, 100, 200000),
    maxTokens: integer("maxTokens", 220, 64, 1000),
    concurrency: integer("concurrency", 2, 1, 8),
  };
}

/** Use public scope accessors shared by Pi 0.84.4 and 1.0; Pi filters untrusted projects. */
export function configFromSettings(settings: SettingsManager): Config {
  if (settings.drainErrors().length)
    throw new Error("Could not read Pi settings.json");
  const global = (settings.getGlobalSettings() as { toolSummaries?: unknown })
    .toolSummaries;
  const project = (settings.getProjectSettings() as { toolSummaries?: unknown })
    .toolSummaries;
  // Validate each namespace before merging; all settings are scalar values.
  readConfig({ toolSummaries: global });
  readConfig({ toolSummaries: project });
  return readConfig({
    toolSummaries: {
      ...(global as object | undefined),
      ...(project as object | undefined),
    },
  });
}
