import { describe, expect, it } from "vitest";
import { adoptRemoteFloor } from "@/lib/pos/floorSync";
import type { PosTableSession } from "@/lib/pos/posEngine";

function table(sessionId: string, revision: number, quantity: number): PosTableSession {
  return {
    sessionId,
    tableId: sessionId,
    revision,
    status: "OPEN",
    lines: [{ quantity }],
    tickets: [],
  } as unknown as PosTableSession;
}

describe("adoptRemoteFloor", () => {
  it("shows a table another waiter just opened", () => {
    const revisions = new Map<string, number>();
    const snapshots = new Map<string, string>();
    const remote = table("s2", 1, 1);
    const adopted = adoptRemoteFloor([], [remote], revisions, snapshots);
    expect(adopted.sessions).toEqual([remote]);
    expect(adopted.changed).toBe(true);
    expect(adopted.updatedTableIds).toEqual(["s2"]);
  });

  it("keeps taps that have not been pushed yet", () => {
    const local = table("s1", 2, 3);
    const remote = table("s1", 2, 1);
    const revisions = new Map([["s1", 2]]);
    const snapshots = new Map([["s1", JSON.stringify(remote)]]);
    const adopted = adoptRemoteFloor([local], [remote], revisions, snapshots);
    expect(adopted.sessions).toEqual([local]);
    expect(adopted.changed).toBe(false);
  });

  it("replaces a dirty table after the server refused the write", () => {
    const local = table("s1", 2, 3);
    const remote = table("s1", 3, 4);
    const revisions = new Map([["s1", 2]]);
    const snapshots = new Map([["s1", JSON.stringify(table("s1", 2, 1))]]);
    const adopted = adoptRemoteFloor([local], [remote], revisions, snapshots, new Set(["s1"]));
    expect(adopted.sessions).toEqual([remote]);
    expect(adopted.updatedTableIds).toEqual(["s1"]);
  });

  it("ignores a poll that is behind the revision this device already accepted", () => {
    const local = table("s1", 4, 2);
    const remote = table("s1", 3, 9);
    const revisions = new Map([["s1", 4]]);
    const snapshots = new Map([["s1", JSON.stringify(local)]]);
    const adopted = adoptRemoteFloor([local], [remote], revisions, snapshots);
    expect(adopted.sessions).toEqual([local]);
  });
});
