import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUEST_COPY, RequestFailure, requestJson } from "@/lib/requestJson";
import { DINING_PAY_LIMITS, readDiningPayBill } from "@/lib/cartEngine";

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function failure(promise: Promise<unknown>): Promise<RequestFailure> {
  const caught = await promise.then(
    () => null,
    (error: unknown) => error
  );
  expect(caught).toBeInstanceOf(RequestFailure);
  return caught as RequestFailure;
}

const html = (status: number) =>
  new Response("<!doctype html><title>Bad gateway</title>", {
    status,
    headers: { "Content-Type": "text/html" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ST-14 · requestJson maps every transport failure to words", () => {
  it("never surfaces a JSON parse error from an HTML error page", async () => {
    stubFetch(async () => html(500));
    const error = await failure(requestJson("/x", { fallbackMessage: "Checkout failed." }));
    expect(error.message).toBe("Checkout failed.");
    expect(error.message).not.toMatch(/Unexpected token|JSON/);
    expect(error.kind).toBe("rejected");
    expect(error.status).toBe(500);
    expect(error.outcomeUnknown).toBe(false);
  });

  it("treats a gateway timeout as an unknown outcome, not a refusal", async () => {
    for (const status of [502, 504]) {
      stubFetch(async () => html(status));
      expect((await failure(requestJson("/x"))).outcomeUnknown).toBe(true);
    }
    stubFetch(async () => html(503));
    expect((await failure(requestJson("/x"))).outcomeUnknown).toBe(false);
  });

  it("passes on the server's own refusal message", async () => {
    stubFetch(async () => Response.json({ message: "That slot was just taken." }, { status: 409 }));
    const error = await failure(requestJson("/x", { fallbackMessage: "fallback" }));
    expect(error.message).toBe("That slot was just taken.");
  });

  it("ignores a blank or non-string server message", async () => {
    for (const body of [{ message: "   " }, { message: 42 }, ["array"], null]) {
      stubFetch(async () => Response.json(body, { status: 400 }));
      expect((await failure(requestJson("/x", { fallbackMessage: "fallback" }))).message).toBe(
        "fallback"
      );
    }
  });

  it("says 'took too long' instead of 'signal timed out'", async () => {
    stubFetch(async () => {
      throw new DOMException("signal timed out", "TimeoutError");
    });
    const error = await failure(requestJson("/x"));
    expect(error.message).toBe(REQUEST_COPY.timeout);
    expect(error.kind).toBe("timeout");
    expect(error.outcomeUnknown).toBe(true);
  });

  it("times out while the body is still streaming", async () => {
    const response = new Response("{}");
    vi.spyOn(response, "json").mockRejectedValue(new DOMException("signal timed out", "TimeoutError"));
    stubFetch(async () => response);
    const error = await failure(requestJson("/x"));
    expect(error.kind).toBe("timeout");
    expect(error.status).toBe(200);
  });

  it("says 'couldn't reach' instead of 'Failed to fetch'", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    const error = await failure(requestJson("/x"));
    expect(error.message).toBe(REQUEST_COPY.network);
    expect(error.outcomeUnknown).toBe(true);
  });

  it("refuses a 200 that is not JSON rather than handing on null", async () => {
    stubFetch(async () => html(200));
    const error = await failure(requestJson("/x"));
    expect(error.kind).toBe("unreadable");
    expect(error.message).toBe(REQUEST_COPY.unreadable);
  });

  it("sends JSON with a timeout signal and merges caller headers", async () => {
    const fetchMock = stubFetch(async () => Response.json({ ok: true }));
    const result = await requestJson("/api/x", {
      body: { a: 1 },
      headers: { "Idempotency-Key": "k1" },
    });
    expect(result).toEqual({ ok: true });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"a":1}');
    expect(init.headers).toEqual({ "Content-Type": "application/json", "Idempotency-Key": "k1" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends a GET without a body or content type", async () => {
    const fetchMock = stubFetch(async () => Response.json([]));
    await requestJson("/api/x");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });
});

describe("ST-14 · DiningPay reads the bill as typed", () => {
  it("never reads an empty or half-typed field as ₹0", () => {
    for (const raw of ["", "   ", "₹"]) {
      expect(readDiningPayBill(raw)).toEqual({
        amount: null,
        problem: "Enter your table bill amount.",
      });
    }
  });

  it("refuses negatives, exponents and words with a reason", () => {
    for (const raw of ["-500", "1e5", "abc", "12-3", "0x10"]) {
      const bill = readDiningPayBill(raw);
      expect(bill.amount, raw).toBeNull();
      expect(bill.problem, raw).toBe("Enter the bill as a number of rupees.");
    }
  });

  it("refuses paise rather than rounding them away", () => {
    expect(readDiningPayBill("2500.50").problem).toBe("Enter the bill in whole rupees.");
    expect(readDiningPayBill("2500.").problem).toBe("Enter the bill in whole rupees.");
  });

  it("accepts the way people write rupees", () => {
    expect(readDiningPayBill("2,500").amount).toBe(2500);
    expect(readDiningPayBill("₹ 2500 ").amount).toBe(2500);
    expect(readDiningPayBill("1,00,000").amount).toBe(100000);
  });

  it("enforces the minimum and maximum it advertises, inclusive", () => {
    expect(readDiningPayBill(String(DINING_PAY_LIMITS.minBill)).amount).toBe(DINING_PAY_LIMITS.minBill);
    expect(readDiningPayBill(String(DINING_PAY_LIMITS.minBill - 1)).problem).toBe("DiningPay starts at ₹100.");
    expect(readDiningPayBill("0").problem).toBe("DiningPay starts at ₹100.");
    expect(readDiningPayBill(String(DINING_PAY_LIMITS.maxBill)).amount).toBe(DINING_PAY_LIMITS.maxBill);
    expect(readDiningPayBill(String(DINING_PAY_LIMITS.maxBill + 1)).problem).toBe(
      "DiningPay covers bills up to ₹5,00,000."
    );
    expect(readDiningPayBill("9".repeat(400)).amount).toBeNull();
  });
});
