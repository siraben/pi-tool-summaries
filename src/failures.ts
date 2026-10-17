export type FailureKind =
  "authentication" | "rate-limit" | "provider" | "other";

/** Only locally defined messages reach the UI; raw provider errors stay in causes. */
export class SummaryFailure extends Error {
  constructor(
    message: string,
    cause?: unknown,
    readonly kind: FailureKind = "other",
  ) {
    super(message, { cause });
    this.name = "SummaryFailure";
  }
}

export function providerFailure(cause: unknown): SummaryFailure {
  const error = cause as
    | {
        status?: unknown;
        statusCode?: unknown;
        message?: unknown;
        errorMessage?: unknown;
      }
    | undefined;
  const raw = error?.errorMessage ?? error?.message;
  const message = typeof raw === "string" ? raw : "";
  const status =
    error?.status ??
    error?.statusCode ??
    message.match(/^(?:HTTP\s+)?([45]\d\d)\b/i)?.[1];
  const number =
    typeof status === "number" || typeof status === "string"
      ? Number(status)
      : NaN;
  const detail =
    Number.isInteger(number) && number >= 400 && number <= 599
      ? ` (HTTP ${number})`
      : "";
  const kind: FailureKind =
    number === 401 ||
    number === 403 ||
    /no api key|authentication unavailable|not authenticated|missing.*credential|expired.*token/i.test(
      message,
    )
      ? "authentication"
      : number === 429
        ? "rate-limit"
        : "provider";
  const label =
    kind === "authentication"
      ? "Provider authentication/access unavailable"
      : kind === "rate-limit"
        ? "Provider rate limited"
        : "Provider/API failure";
  return new SummaryFailure(`${label}${detail}`, cause, kind);
}
