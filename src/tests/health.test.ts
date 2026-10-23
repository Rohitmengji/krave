import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const one = vi.fn();
vi.mock("@/lib/server/pg", () => ({ one: (...args: unknown[]) => one(...args) }));

const { GET } = await import("@/app/api/health/route");

describe("GET /api/health", () => {
  beforeEach(() => {
    one.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("SMTP_HOST", "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("is ok when the database answers and the schema is applied", async () => {
    one.mockResolvedValue({ managed: "managed_restaurants", orders: "orders" });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.features).toEqual({ uploads: false, menuImport: false, email: false });
  });

  it("reports configured features without exposing their values", async () => {
    one.mockResolvedValue({ managed: "managed_restaurants", orders: "orders" });
    vi.stubEnv("OPENAI_API_KEY", "sk-test-should-never-appear");
    const body = await (await GET()).json();
    expect(body.features.menuImport).toBe(true);
    expect(JSON.stringify(body)).not.toContain("sk-test");
  });

  it("is degraded with 503 when the schema has not been applied", async () => {
    one.mockResolvedValue({ managed: null, orders: "orders" });
    const response = await GET();
    expect(response.status).toBe(503);
    expect((await response.json()).checks.schema.status).toBe("down");
  });

  it("is degraded with 503 and no driver detail when the database is unreachable", async () => {
    one.mockRejectedValue(new Error("connect ECONNREFUSED ep-secret-host.neon.tech"));
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.checks.database).toEqual({ status: "down", reason: "unreachable" });
    expect(JSON.stringify(body)).not.toContain("ep-secret-host");
  });

  it("gives up on a hung database instead of hanging the monitor", async () => {
    vi.useFakeTimers();
    one.mockReturnValue(new Promise(() => {}));
    const pending = GET();
    await vi.advanceTimersByTimeAsync(8_000);
    const response = await pending;
    expect(response.status).toBe(503);
    expect((await response.json()).checks.database).toEqual({ status: "down", reason: "timeout" });
  });
});
