import { describe, expect, it } from "vitest";
import {
  adoptRemoteFloor,
  describeRefusal,
  floorItemsChanged,
  floorPollDelay,
  floorTablesToFetch,
  FLOOR_BUSY_FOR_MS,
  FLOOR_POLL_BUSY_MS,
  FLOOR_POLL_QUIET_MS,
  sameOrder,
  unsavedItems,
} from "@/lib/pos/floorSync";
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

function withLines(
  sessionId: string,
  lines: { lineId: string; name: string; quantity: number }[],
  status = "OPEN"
): PosTableSession {
  return { ...table(sessionId, 1, 0), status, lines } as unknown as PosTableSession;
}

describe("adoptRemoteFloor", () => {
  /** What the device knows; by default nothing on its floor came from elsewhere. */
  function knowing(
    revisions: [string, number][] = [],
    snapshots: [string, PosTableSession][] = [],
    options: { fromElsewhere?: PosTableSession[]; force?: string[] } = {}
  ) {
    return {
      revisions: new Map(revisions),
      snapshots: new Map(snapshots.map(([id, session]) => [id, JSON.stringify(session)])),
      fromElsewhere: new Set(options.fromElsewhere ?? []),
      force: new Set(options.force ?? []),
    };
  }

  it("shows a table another waiter just opened", () => {
    const remote = table("s2", 1, 1);
    const adopted = adoptRemoteFloor([], [remote], knowing());
    expect(adopted.sessions).toEqual([remote]);
    expect(adopted.changed).toBe(true);
  });

  it("keeps taps that have not been pushed yet", () => {
    const local = table("s1", 2, 3);
    const remote = table("s1", 2, 1);
    const adopted = adoptRemoteFloor([local], [remote], knowing([["s1", 2]], [["s1", remote]]));
    expect(adopted.sessions).toEqual([local]);
    expect(adopted.changed).toBe(false);
  });

  it("keeps a table opened here while its first save is still on the way", () => {
    // The poll already sees the empty table the first save created; the taps since are only here.
    const local = table("s1", 0, 2);
    const firstSave = table("s1", 1, 0);
    const adopted = adoptRemoteFloor([local], [firstSave], knowing());
    expect(adopted.sessions[0]).toBe(local);
  });

  it("replaces a stale copy this device restored from storage", () => {
    const restored = table("s1", 1, 1);
    const newer = table("s1", 2, 3);
    const adopted = adoptRemoteFloor([restored], [newer], knowing([], [], { fromElsewhere: [restored] }));
    expect(adopted.sessions[0]).toBe(newer);
  });

  it("replaces a dirty table after the server refused the write", () => {
    const local = table("s1", 2, 3);
    const remote = table("s1", 3, 4);
    const adopted = adoptRemoteFloor(
      [local],
      [remote],
      knowing([["s1", 2]], [["s1", table("s1", 2, 1)]], { force: ["s1"] })
    );
    expect(adopted.sessions).toEqual([remote]);
  });

  it("ignores a poll that is behind the revision this device already accepted", () => {
    const local = table("s1", 4, 2);
    const remote = table("s1", 3, 9);
    const adopted = adoptRemoteFloor([local], [remote], knowing([["s1", 4]], [["s1", local]]));
    expect(adopted.sessions).toEqual([local]);
  });

  it("follows another waiter's change to a table this device has not touched", () => {
    const local = table("s1", 2, 1);
    const remote = table("s1", 3, 2);
    const adopted = adoptRemoteFloor([local], [remote], knowing([["s1", 2]], [["s1", local]]));
    expect(adopted.sessions[0]).toBe(remote);
  });

  it("gives the same answer twice and never edits what it was given", () => {
    // Strict Mode runs state updaters twice; a second run must not see a different floor.
    const local = table("s1", 2, 1);
    const remote = table("s1", 3, 2);
    const knowledge = knowing([["s1", 2]], [["s1", local]]);
    const first = adoptRemoteFloor([local], [remote], knowledge);
    const second = adoptRemoteFloor([local], [remote], knowledge);
    expect(second.sessions).toEqual(first.sessions);
    expect(knowledge.revisions).toEqual(new Map([["s1", 2]]));
    expect(knowledge.snapshots).toEqual(new Map([["s1", JSON.stringify(local)]]));
  });
});

describe("floorTablesToFetch", () => {
  it("fetches only tables whose revision this device has not synced", () => {
    const revisions = new Map([
      ["s1", 3],
      ["s2", 1],
    ]);
    const ids = floorTablesToFetch(
      [table("s1", 3, 1), table("s2", 1, 1)],
      [
        ["s1", 3],
        ["s2", 2],
        ["s3", 1],
      ],
      revisions
    );
    expect(ids).toEqual(["s2", "s3"]);
  });

  it("fetches a synced table that is no longer open, so a bill paid elsewhere closes here", () => {
    const ids = floorTablesToFetch([table("s1", 3, 1)], [], new Map([["s1", 3]]));
    expect(ids).toEqual(["s1"]);
  });

  it("leaves alone a table this device opened but has not pushed yet", () => {
    expect(floorTablesToFetch([table("s9", 0, 1)], [], new Map())).toEqual([]);
  });
});

describe("floorPollDelay", () => {
  it("polls quickly while the floor is busy and slowly once it is quiet", () => {
    expect(floorPollDelay(10_000, 10_000 + FLOOR_BUSY_FOR_MS - 1)).toBe(FLOOR_POLL_BUSY_MS);
    expect(floorPollDelay(10_000, 10_000 + FLOOR_BUSY_FOR_MS)).toBe(FLOOR_POLL_QUIET_MS);
    expect(floorPollDelay(0, Date.now())).toBe(FLOOR_POLL_QUIET_MS);
  });
});

describe("floorItemsChanged", () => {
  it("speaks up for a new table or moved items, not for a re-save of the same order", () => {
    expect(floorItemsChanged(undefined, table("s1", 1, 1))).toBe(true);
    expect(floorItemsChanged(table("s1", 1, 1), table("s1", 2, 1))).toBe(false);
    expect(floorItemsChanged(table("s1", 1, 1), table("s1", 2, 3))).toBe(true);
  });
});

describe("refused writes", () => {
  const base = withLines("T5", [{ lineId: "a", name: "Dal", quantity: 1 }]);
  const sent = withLines("T5", [
    { lineId: "a", name: "Dal", quantity: 2 },
    { lineId: "b", name: "Roti", quantity: 3 },
  ]);

  it("lists exactly what this device added that the server does not have", () => {
    const saved = withLines("T5", [
      { lineId: "a", name: "Dal", quantity: 1 },
      { lineId: "c", name: "Rice", quantity: 1 },
    ]);
    expect(unsavedItems(sent, base, saved)).toEqual(["1× Dal", "3× Roti"]);
  });

  it("does not blame this device for an item another waiter removed", () => {
    // Dal was already synced; the other phone removed it. Only Roti was added here.
    const saved = withLines("T5", []);
    const onlyRoti = withLines("T5", [
      { lineId: "a", name: "Dal", quantity: 1 },
      { lineId: "b", name: "Roti", quantity: 3 },
    ]);
    expect(unsavedItems(onlyRoti, base, saved)).toEqual(["3× Roti"]);
  });

  it("tells the waiter what to ring up again after a conflict", () => {
    const saved = withLines("T5", [{ lineId: "a", name: "Dal", quantity: 1 }]);
    const message = describeRefusal({ kind: "conflict", reason: "stale", sent, base, saved });
    expect(message).toBe(
      "Table T5 was changed on another phone at the same time, so it shows their order now. Not saved: 1× Dal, 3× Roti. Add them again if still wanted."
    );
  });

  it("says when the table was already closed on another phone", () => {
    const saved = withLines("T5", [{ lineId: "a", name: "Dal", quantity: 1 }], "SETTLED");
    expect(describeRefusal({ kind: "conflict", reason: "stale", sent, base, saved })).toBe(
      "Table T5 was already closed on another phone. Not saved: 1× Dal, 3× Roti."
    );
  });

  it("keeps the server's reason for a table it will not store", () => {
    expect(
      describeRefusal({ kind: "rejected", reason: '"Roti" is no longer on the menu.', sent, base, saved: null })
    ).toBe('Table T5 could not be saved: "Roti" is no longer on the menu.');
  });

  it("recognises a retried push the server already stored, whatever it charged", () => {
    // The answer to the first push was lost; the retry is refused, but nothing is missing.
    const saved = {
      ...sent,
      revision: 4,
      outletName: "Jagadamba Maratha Khanawali",
      lines: sent.lines.map((line) => ({ ...line, unitPrice: 120 })),
    } as PosTableSession;
    expect(sameOrder(sent, saved)).toBe(true);
    expect(sameOrder(sent, withLines("T5", [{ lineId: "a", name: "Dal", quantity: 2 }]))).toBe(false);
  });
});
