import type { PosTableSession } from "@/lib/pos/posEngine";

/** How quickly another waiter's items should show up on this terminal. */
export const FLOOR_POLL_MS = 1_500;
/** A burst of taps is one push, but not so long that the next waiter waits. */
export const FLOOR_PUSH_MS = 400;

export interface FloorAdoption {
  sessions: PosTableSession[];
  /** True when the list the terminal should render is not the one it already has. */
  changed: boolean;
  /** Tables whose items moved because another terminal wrote first. */
  updatedTableIds: string[];
}

function lineCount(session: PosTableSession): number {
  return session.lines.reduce((total, line) => total + line.quantity, 0);
}

function sameFloor(left: readonly PosTableSession[], right: readonly PosTableSession[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((session, index) => session === right[index]);
}

/**
 * Fold the server floor into this device's working copy.
 *
 * A table this device has edited since the last accepted sync is left alone, so a poll
 * cannot wipe taps that have not been pushed yet. Everything else follows the server,
 * including a table another waiter just opened or added to. A forced id is a conflict:
 * the server already refused this device's write, so the latest table replaces it.
 */
export function adoptRemoteFloor(
  local: readonly PosTableSession[],
  remote: readonly PosTableSession[],
  revisions: Map<string, number>,
  snapshots: Map<string, string>,
  forceIds: ReadonlySet<string> = new Set()
): FloorAdoption {
  const remoteById = new Map(remote.map((session) => [session.sessionId, session]));
  const updatedTableIds: string[] = [];
  const next: PosTableSession[] = [];
  const seen = new Set<string>();

  for (const session of local) {
    seen.add(session.sessionId);
    const incoming = remoteById.get(session.sessionId);
    const known = Math.max(revisions.get(session.sessionId) ?? 0, session.revision);
    const json = JSON.stringify(session);
    const baselined = snapshots.get(session.sessionId);
    const dirty = baselined !== undefined && baselined !== json;
    const forced = forceIds.has(session.sessionId);
    if (!incoming || (!forced && (dirty || incoming.revision < known))) {
      next.push(session);
      continue;
    }
    if (!forced && incoming.revision === known && baselined === undefined && json !== JSON.stringify(incoming)) {
      // Same revision, never baselined: this device still has an unpushed edit.
      next.push(session);
      continue;
    }
    if (
      json !== JSON.stringify(incoming) &&
      (lineCount(incoming) !== lineCount(session) || incoming.tickets.length !== session.tickets.length)
    ) {
      updatedTableIds.push(incoming.tableId);
    }
    revisions.set(incoming.sessionId, incoming.revision);
    snapshots.set(incoming.sessionId, JSON.stringify(incoming));
    next.push(incoming);
  }

  for (const incoming of remote) {
    if (seen.has(incoming.sessionId)) continue;
    const known = revisions.get(incoming.sessionId) ?? 0;
    if (incoming.revision < known) continue;
    revisions.set(incoming.sessionId, incoming.revision);
    snapshots.set(incoming.sessionId, JSON.stringify(incoming));
    if (incoming.status === "OPEN") updatedTableIds.push(incoming.tableId);
    next.push(incoming);
  }

  return {
    sessions: next,
    changed: !sameFloor(local, next),
    updatedTableIds,
  };
}
