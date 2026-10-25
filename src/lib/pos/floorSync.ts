import type { PosTableSession } from "@/lib/pos/posEngine";

/*
 * Every visible terminal polls, and each poll is a function call and a database query. On the
 * free Vercel and Neon plans a fixed 1.5s poll per screen, all day, uses up the monthly
 * allowance, so the floor is polled quickly only while it is busy.
 */

/** While the floor is busy, another waiter's taps show up on this terminal this quickly. */
export const FLOOR_POLL_BUSY_MS = 2_000;
/** A quiet floor is checked less often; the next change anywhere makes it busy again. */
export const FLOOR_POLL_QUIET_MS = 10_000;
/** How long after the last change, here or on another terminal, the floor counts as busy. */
export const FLOOR_BUSY_FOR_MS = 60_000;
/** A burst of taps is one push, but not so long that the next waiter waits. */
export const FLOOR_PUSH_MS = 400;
/** After a failed push the next attempt waits this long, so an offline phone is not hammering. */
export const FLOOR_RETRY_MS = 5_000;

export function floorPollDelay(lastChangeAt: number, now: number): number {
  return now - lastChangeAt < FLOOR_BUSY_FOR_MS ? FLOOR_POLL_BUSY_MS : FLOOR_POLL_QUIET_MS;
}

export interface FloorAdoption {
  sessions: PosTableSession[];
  /** True when the list the terminal should render is not the one it already has. */
  changed: boolean;
}

function lineCount(session: PosTableSession): number {
  return session.lines.reduce((total, line) => total + line.quantity, 0);
}

/** What this device knows about its own copy of the floor, for deciding whose table wins. */
export interface FloorKnowledge {
  /** The server revision this device's next write to each table is based on. */
  revisions: ReadonlyMap<string, number>;
  /** Each table as this device last had it accepted (or adopted) by the server. */
  snapshots: ReadonlyMap<string, string>;
  /**
   * Table objects this device did not change itself: restored from its storage when the page
   * loaded, or taken from the server. Anything else was edited here.
   */
  fromElsewhere: { has(session: PosTableSession): boolean };
  /** Tables whose write the server refused, so its copy replaces this device's. */
  force?: ReadonlySet<string>;
}

function shouldTakeServerCopy(
  session: PosTableSession,
  incoming: PosTableSession,
  knowledge: FloorKnowledge
): boolean {
  // The server refused this device's write, so its table is the one to show.
  if (knowledge.force?.has(session.sessionId)) return true;
  const known = Math.max(knowledge.revisions.get(session.sessionId) ?? 0, session.revision);
  if (incoming.revision < known) return false;
  const json = JSON.stringify(session);
  const baselined = knowledge.snapshots.get(session.sessionId);
  // Taps this device has not had accepted yet win; the push carries them.
  if (baselined !== undefined) return baselined === json;
  // Never synced from here. A table opened or edited on this device is still on its way to the
  // server: a poll that sees an earlier save of it must not wipe the taps since.
  if (!knowledge.fromElsewhere.has(session)) return false;
  // Restored from storage: the same revision with different contents is an edit never pushed.
  return !(incoming.revision === known && json !== JSON.stringify(incoming));
}

/**
 * Fold server copies of some tables into this device's working copy of the floor.
 *
 * A table this device has edited since the last accepted sync is left alone, so a poll
 * cannot wipe taps that have not been pushed yet. Everything else follows the server,
 * including a table another waiter just opened or added to. A forced id is a refusal: the
 * server already turned down this device's write, so the server's table replaces it.
 *
 * Pure, so it is safe inside a state updater: the caller records what this device now agrees
 * with the server only once the result is on screen.
 */
export function adoptRemoteFloor(
  local: readonly PosTableSession[],
  remote: readonly PosTableSession[],
  knowledge: FloorKnowledge
): FloorAdoption {
  const remoteById = new Map(remote.map((session) => [session.sessionId, session]));
  const next: PosTableSession[] = [];
  const seen = new Set<string>();

  for (const session of local) {
    seen.add(session.sessionId);
    const incoming = remoteById.get(session.sessionId);
    next.push(incoming && shouldTakeServerCopy(session, incoming, knowledge) ? incoming : session);
  }
  for (const incoming of remote) {
    if (seen.has(incoming.sessionId)) continue;
    if (incoming.revision < (knowledge.revisions.get(incoming.sessionId) ?? 0)) continue;
    next.push(incoming);
  }

  return {
    sessions: next,
    changed: next.length !== local.length || next.some((session, index) => session !== local[index]),
  };
}

/**
 * Which tables to fetch after the floor's version moved: any open table whose revision this
 * device has not synced, and any table it synced as open that is no longer open on the server
 * (paid, merged or moved on another terminal).
 */
export function floorTablesToFetch(
  local: readonly PosTableSession[],
  heads: readonly (readonly [string, number])[],
  revisions: ReadonlyMap<string, number>
): string[] {
  const open = new Map(heads);
  const ids = new Set<string>();
  for (const [sessionId, revision] of heads) {
    if (revisions.get(sessionId) !== revision) ids.add(sessionId);
  }
  for (const session of local) {
    if (session.status === "OPEN" && revisions.has(session.sessionId) && !open.has(session.sessionId)) {
      ids.add(session.sessionId);
    }
  }
  return [...ids];
}

/** Worth telling the waiter about: a new table, or items, tickets or status that moved. */
export function floorItemsChanged(before: PosTableSession | undefined, after: PosTableSession): boolean {
  if (!before) return after.status === "OPEN";
  return (
    before.status !== after.status ||
    lineCount(before) !== lineCount(after) ||
    before.tickets.length !== after.tickets.length
  );
}

/**
 * The items this device added since its last accepted sync that the server's table does not
 * have, so a waiter whose write was refused knows exactly what to ring up again.
 */
export function unsavedItems(
  sent: PosTableSession,
  base: PosTableSession | null,
  saved: PosTableSession | null
): string[] {
  const baseQuantity = new Map((base?.lines ?? []).map((line) => [line.lineId, line.quantity]));
  const savedQuantity = new Map((saved?.lines ?? []).map((line) => [line.lineId, line.quantity]));
  return sent.lines.flatMap((line) => {
    const added = line.quantity - (baseQuantity.get(line.lineId) ?? 0);
    const missing = line.quantity - (savedQuantity.get(line.lineId) ?? 0);
    const lost = Math.min(added, missing);
    return lost > 0 ? [`${lost}× ${line.name}`] : [];
  });
}

/**
 * True when the server already holds exactly the order this device sent. A push whose answer
 * was lost (a timeout on a weak signal) is retried on the old revision and refused, yet nothing
 * was lost, so the waiter should not be told another phone changed the table. Prices, the
 * restaurant's name and tax are the server's to set, so they are not compared.
 */
export function sameOrder(sent: PosTableSession, saved: PosTableSession): boolean {
  const comparable = (session: PosTableSession) =>
    JSON.stringify({
      ...session,
      revision: 0,
      outletName: "",
      taxRateBps: 0,
      lines: session.lines.map((line) => ({ ...line, unitPrice: 0 })),
    });
  return comparable(sent) === comparable(saved);
}

/** What the terminal says when the server would not store a table as this device sent it. */
export function describeRefusal(input: {
  kind: "conflict" | "rejected";
  reason: string;
  sent: PosTableSession;
  base: PosTableSession | null;
  saved: PosTableSession | null;
}): string {
  const { kind, reason, sent, base, saved } = input;
  const lost = unsavedItems(sent, base, saved);
  const notSaved = lost.length > 0 ? ` Not saved: ${lost.join(", ")}.` : "";
  if (kind === "rejected") {
    return saved
      ? `Table ${sent.tableId} could not be saved: ${reason}${notSaved} Showing the saved order.`
      : `Table ${sent.tableId} could not be saved: ${reason}`;
  }
  if (saved && saved.status !== "OPEN") {
    return `Table ${sent.tableId} was already closed on another phone.${notSaved}`;
  }
  const again = lost.length > 0 ? " Add them again if still wanted." : "";
  return `Table ${sent.tableId} was changed on another phone at the same time, so it shows their order now.${notSaved}${again}`;
}
