/**
 * One JSON object per line, so Vercel's log search can filter on `event` and `level`.
 * Context is an allow-listed set of scalar identifiers: never pass request bodies,
 * cookies, credentials, emails or phone numbers.
 */
export type LogContext = Record<string, string | number | boolean | null | undefined>;

const SENSITIVE_KEY = /pass(word)?|secret|token|cookie|authori[sz]ation|api[-_]?key|email|phone|otp|session/i;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(postgres(?:ql)?|mysql|redis|https?):\/\/[^\s:@/]+:[^\s@/]+@/gi, "$1://[redacted]@"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g, "[redacted-access-key]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]"],
];

const MAX_TEXT = 2_000;

export function redactLogText(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result.length > MAX_TEXT ? `${result.slice(0, MAX_TEXT)}…` : result;
}

type SerializedError = { name: string; message: string; code?: string; stack?: string; cause?: SerializedError };

function serializeError(error: unknown, depth = 0): SerializedError {
  if (!(error instanceof Error)) {
    return { name: typeof error, message: redactLogText(String(error)) };
  }
  const code = (error as { code?: unknown }).code;
  const serialized: SerializedError = {
    name: error.name,
    message: redactLogText(error.message),
    ...(typeof code === "string" || typeof code === "number" ? { code: String(code) } : {}),
    ...(error.stack ? { stack: redactLogText(error.stack) } : {}),
  };
  if (error.cause !== undefined && depth < 2) {
    serialized.cause = serializeError(error.cause, depth + 1);
  }
  return serialized;
}

function safeContext(context: LogContext | undefined): Record<string, string | number | boolean | null> {
  const safe: Record<string, string | number | boolean | null> = {};
  if (!context) return safe;
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue;
    if (SENSITIVE_KEY.test(key)) {
      safe[key] = "[redacted]";
      continue;
    }
    safe[key] = typeof value === "string" ? redactLogText(value) : value;
  }
  return safe;
}

function write(level: "info" | "warn" | "error", event: string, payload: Record<string, unknown>): void {
  const line = JSON.stringify({ level, event, time: new Date().toISOString(), ...payload });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export function logServerError(event: string, error: unknown, context?: LogContext): void {
  write("error", event, { ...safeContext(context), error: serializeError(error) });
}

export function logServerEvent(level: "info" | "warn", event: string, context?: LogContext): void {
  write(level, event, safeContext(context));
}
