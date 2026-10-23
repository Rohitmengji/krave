/**
 * Browser-side JSON requests with one mapping from transport failures to words a customer
 * can act on, so no screen ever shows "Unexpected token '<'" or "signal timed out".
 */

export type RequestFailureKind = "timeout" | "network" | "rejected" | "unreadable";

export const REQUEST_COPY = {
  timeout: "The server took too long to answer. Please try again.",
  network: "Couldn't reach KRAVE. Check your connection and try again.",
  unreadable: "The server sent a reply we couldn't read. Please try again.",
} as const;

export class RequestFailure extends Error {
  constructor(
    message: string,
    readonly kind: RequestFailureKind,
    readonly status: number | null = null
  ) {
    super(message);
    this.name = "RequestFailure";
  }

  /**
   * The request may have been acted on even though no answer arrived: a timeout, a
   * dropped connection, or a gateway that gave up waiting on the server.
   */
  get outcomeUnknown(): boolean {
    return (
      this.kind === "timeout" ||
      this.kind === "network" ||
      this.status === 502 ||
      this.status === 504
    );
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

/**
 * Sends `body` as JSON (when given) and resolves with the parsed reply. Rejects only with
 * a RequestFailure whose message is fit to show: the server's own `message` when it
 * refused, otherwise `fallbackMessage` or one of REQUEST_COPY.
 */
export async function requestJson(
  url: string,
  {
    body,
    method = body === undefined ? "GET" : "POST",
    headers,
    timeoutMs = 8000,
    fallbackMessage = "The server did not accept that.",
  }: {
    body?: unknown;
    method?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    fallbackMessage?: string;
  } = {}
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
      signal: AbortSignal.timeout(timeoutMs),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw isTimeout(error)
      ? new RequestFailure(REQUEST_COPY.timeout, "timeout")
      : new RequestFailure(REQUEST_COPY.network, "network");
  }

  let result: unknown = null;
  let readable = true;
  try {
    result = await response.json();
  } catch (error) {
    // The timer still runs while the body streams in.
    if (isTimeout(error)) throw new RequestFailure(REQUEST_COPY.timeout, "timeout", response.status);
    readable = false;
  }

  if (!response.ok) {
    const message = (result as { message?: unknown } | null)?.message;
    throw new RequestFailure(
      typeof message === "string" && message.trim() ? message : fallbackMessage,
      "rejected",
      response.status
    );
  }
  if (!readable) throw new RequestFailure(REQUEST_COPY.unreadable, "unreadable", response.status);
  return result;
}
