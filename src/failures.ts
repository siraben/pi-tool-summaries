/** Only locally defined messages reach the UI; raw provider errors stay in causes. */
export class SummaryFailure extends Error {
  constructor(message: string, cause?: unknown) {
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
  return new SummaryFailure(`Provider/API failure${detail}`, cause);
}
