import { useEffect, useEffectEvent, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  restorePosSessions,
  restorePosShift,
  type PosOutlet,
  type PosShift,
  type PosTableSession,
} from "@/lib/pos/posEngine";
import {
  adoptRemoteFloor,
  describeRefusal,
  floorItemsChanged,
  floorPollDelay,
  floorTablesToFetch,
  FLOOR_POLL_BUSY_MS,
  FLOOR_PUSH_MS,
  FLOOR_RETRY_MS,
  sameOrder,
} from "@/lib/pos/floorSync";

export type PosSyncState = "local" | "pending" | "synced" | "failed";

const REQUEST_TIMEOUT_MS = 8_000;
const PUSH_TIMEOUT_MS = 10_000;
const DEVICE_KEY = "krave.pos.device.v1";
let unstoredDeviceId: string | null = null;

function newDeviceId(): string {
  // getRandomValues, unlike randomUUID, also works on a plain-http LAN address.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/** This phone's id, so the server can tell its retry after a lost answer from another phone. */
function deviceId(): string {
  try {
    const known = localStorage.getItem(DEVICE_KEY);
    if (known && /^[A-Za-z0-9-]{8,64}$/.test(known)) return known;
    const fresh = newDeviceId();
    localStorage.setItem(DEVICE_KEY, fresh);
    return fresh;
  } catch {
    unstoredDeviceId ??= newDeviceId();
    return unstoredDeviceId;
  }
}

/** A GET that gives up after a few seconds, or as soon as `stop` fires. */
async function getJson(url: string, stop: AbortSignal): Promise<Record<string, unknown>> {
  if (stop.aborted) throw new Error("Stopped.");
  const request = new AbortController();
  const abort = () => request.abort();
  stop.addEventListener("abort", abort);
  const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: "no-store", signal: request.signal });
    if (!response.ok) throw new Error(`Request failed with ${response.status}.`);
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } finally {
    clearTimeout(timer);
    stop.removeEventListener("abort", abort);
  }
}

function numberRecord(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1]))
  );
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function refusalList(value: unknown): { sessionId: string; reason: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { sessionId, reason } = entry as Record<string, unknown>;
    return typeof sessionId === "string"
      ? [{ sessionId, reason: typeof reason === "string" ? reason : "The server refused it." }]
      : [];
  });
}

function headList(value: unknown): [string, number][] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((head: unknown): [string, number][] =>
    Array.isArray(head) && typeof head[0] === "string" && Number.isSafeInteger(head[1])
      ? [[head[0], head[1] as number]]
      : []
  );
}

function restoreOne(json: string | undefined): PosTableSession | null {
  return json ? (restorePosSessions(`[${json}]`)[0] ?? null) : null;
}

/**
 * Keeps this terminal's floor in step with the server and with every other waiter's terminal.
 *
 * localStorage stays the working copy, so the terminal keeps billing offline. When signed in,
 * changed tables are pushed one request at a time, and the shared floor is polled: a tiny
 * version check while nothing changed, then only the tables this device is behind on.
 */
export function usePosFloorSync({
  hydrated,
  outlets,
  sessions,
  setSessions,
  activeShift,
  setActiveShift,
  setBillNumbers,
  setClaimCodes,
  setUnavailableItemIds,
  announce,
}: {
  hydrated: boolean;
  outlets: PosOutlet[];
  sessions: PosTableSession[];
  setSessions: Dispatch<SetStateAction<PosTableSession[]>>;
  activeShift: PosShift | null;
  setActiveShift: Dispatch<SetStateAction<PosShift | null>>;
  setBillNumbers: Dispatch<SetStateAction<Record<string, number>>>;
  setClaimCodes: Dispatch<SetStateAction<Record<string, string>>>;
  setUnavailableItemIds: Dispatch<SetStateAction<string[]>>;
  announce: (message: string) => void;
}): { syncAccount: string | null; syncState: PosSyncState; syncMessage: string | null } {
  const [syncAccount, setSyncAccount] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<PosSyncState>("local");
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  // Bumped when a push settles, so whatever changed while it was in flight goes next.
  const [pushRound, setPushRound] = useState(0);

  // What this device last agreed with the server about each table: the revision its next write
  // is based on, and the table as it was then. Only tables that differ are sent; resending a
  // whole day's bills on every tap made syncing slower as the day went on.
  const syncRevisions = useRef(new Map<string, number>());
  const syncedSnapshots = useRef(new Map<string, string>());
  const syncedShift = useRef<string | null>(null);
  // A table the server refused is not sent again until it is edited, so a refusal cannot loop.
  const refusedSnapshots = useRef(new Map<string, string>());
  // Server copies handed to setSessions. Their bookkeeping waits until they are on screen, so
  // the state updaters stay pure (Strict Mode runs them twice).
  const serverCopies = useRef(new WeakMap<PosTableSession, { announce: boolean }>());
  // Tables this device did not change itself: restored from storage at load, or from the server.
  const fromElsewhere = useRef(new WeakSet<PosTableSession>());
  const committed = useRef<PosTableSession[]>([]);
  const pushInFlight = useRef(false);
  const queuedBehindPush = useRef(false);
  const lastPushFailed = useRef(false);
  const floorVersion = useRef<string | null>(null);
  const lastFloorChange = useRef(0);

  const isKnownOutlet = useEffectEvent((outletId: number) =>
    outlets.some((outlet) => outlet.outletId === outletId)
  );
  const readFloor = useEffectEvent(() => sessions);
  const tellWaiter = useEffectEvent((message: string) => announce(message));

  const adoptServerCopies = useEffectEvent(
    (remote: PosTableSession[], options: { announce: boolean; force?: ReadonlySet<string> }) => {
      if (remote.length === 0) return;
      for (const session of remote) {
        serverCopies.current.set(session, { announce: options.announce });
        fromElsewhere.current.add(session);
      }
      setSessions((current) => {
        const adopted = adoptRemoteFloor(current, remote, {
          revisions: syncRevisions.current,
          snapshots: syncedSnapshots.current,
          fromElsewhere: fromElsewhere.current,
          force: options.force,
        });
        return adopted.changed ? adopted.sessions : current;
      });
    }
  );

  const settlePush = useEffectEvent(
    (sent: PosTableSession[], shiftJson: string, result: Record<string, unknown>) => {
      const saved = new Map(
        restorePosSessions(JSON.stringify(result.sessions ?? [])).map((session) => [
          session.sessionId,
          session,
        ])
      );
      const refusals = new Map<string, { kind: "conflict" | "rejected"; reason: string }>();
      for (const entry of refusalList(result.rejected)) {
        refusals.set(entry.sessionId, { kind: "rejected", reason: entry.reason });
      }
      for (const entry of refusalList(result.conflicts)) {
        refusals.set(entry.sessionId, { kind: "conflict", reason: entry.reason });
      }

      const replacements: PosTableSession[] = [];
      const messages: string[] = [];
      for (const session of sent) {
        const stored = saved.get(session.sessionId) ?? null;
        const refusal = refusals.get(session.sessionId);
        if (!refusal) {
          if (stored) syncRevisions.current.set(session.sessionId, stored.revision);
          syncedSnapshots.current.set(session.sessionId, JSON.stringify(session));
          continue;
        }
        // What the server holds is what every other terminal shows, so this one shows it too.
        if (stored) replacements.push(stored);
        else refusedSnapshots.current.set(session.sessionId, JSON.stringify(session));
        // A retry of a push whose answer was lost: the server already has this exact order.
        if (stored && refusal.kind === "conflict" && sameOrder(session, stored)) continue;
        messages.push(
          describeRefusal({
            ...refusal,
            sent: session,
            base: restoreOne(syncedSnapshots.current.get(session.sessionId)),
            saved: stored,
          })
        );
      }
      adoptServerCopies(replacements, {
        announce: false,
        force: new Set(replacements.map((session) => session.sessionId)),
      });

      syncedShift.current = shiftJson;
      setSyncState("synced");
      const claimCodes = stringRecord(result.claimCodes);
      setClaimCodes((current) => ({ ...current, ...claimCodes }));
      const billNumbers = numberRecord(result.billNumbers);
      setBillNumbers((current) => ({ ...current, ...billNumbers }));
      setSyncMessage(messages.length > 0 ? messages.join(" ") : null);
    }
  );

  // Once a server copy is on screen, it is what this device agrees with the server about.
  useEffect(() => {
    const before = new Map(committed.current.map((session) => [session.sessionId, session]));
    const updated = new Set<string>();
    for (const session of sessions) {
      const copy = serverCopies.current.get(session);
      if (!copy) continue;
      serverCopies.current.delete(session);
      refusedSnapshots.current.delete(session.sessionId);
      if (session.revision >= (syncRevisions.current.get(session.sessionId) ?? 0)) {
        syncRevisions.current.set(session.sessionId, session.revision);
        syncedSnapshots.current.set(session.sessionId, JSON.stringify(session));
      }
      if (copy.announce && floorItemsChanged(before.get(session.sessionId), session)) {
        updated.add(session.tableId);
      }
    }
    committed.current = sessions;
    if (updated.size > 0) tellWaiter(`Another phone updated table ${[...updated].join(", ")}.`);
  }, [sessions]);

  // Adopt the account's floor once this device knows who is signed in.
  useEffect(() => {
    if (!hydrated) return;
    // What the page restored from this device's storage was not edited in this visit.
    for (const session of readFloor()) fromElsewhere.current.add(session);
    const stop = new AbortController();
    (async () => {
      const account = await getJson("/api/webroutes/account/me", stop.signal);
      if (stop.signal.aborted) return;
      // The 86 list is outlet-wide, so the counter adopts it whether signed in or not.
      if (Array.isArray(account.unavailableItemIds)) {
        setUnavailableItemIds(
          account.unavailableItemIds.filter((id: unknown): id is string => typeof id === "string")
        );
      }
      const user = account.user;
      if (typeof user !== "object" || user === null) return;
      const { displayName } = user as Record<string, unknown>;
      setSyncAccount(typeof displayName === "string" && displayName ? displayName : "your account");

      const state = await getJson("/api/webroutes/pos/state", stop.signal);
      if (stop.signal.aborted) return;
      const stored = restorePosSessions(JSON.stringify(state.sessions ?? [])).filter((session) =>
        isKnownOutlet(session.outletId)
      );
      setBillNumbers(numberRecord(state.billNumbers));
      const claimCodes = stringRecord(state.claimCodes);
      setClaimCodes((current) => ({ ...current, ...claimCodes }));
      adoptServerCopies(stored, { announce: false });
      const storedShift = restorePosShift(JSON.stringify(state.shift ?? null));
      const adoptableShift = storedShift && isKnownOutlet(storedShift.outletId) ? storedShift : null;
      setActiveShift((current) => current ?? adoptableShift);
      setSyncState("synced");
    })().catch(() => {
      // Offline or signed out: the terminal keeps running from this device.
    });
    return () => stop.abort();
  }, [hydrated, setActiveShift, setBillNumbers, setClaimCodes, setUnavailableItemIds]);

  // Push changed tables after taps settle, so a burst of taps is one request.
  useEffect(() => {
    if (!hydrated || !syncAccount) return;
    const changed = sessions.filter((session) => {
      const json = JSON.stringify(session);
      return (
        syncedSnapshots.current.get(session.sessionId) !== json &&
        refusedSnapshots.current.get(session.sessionId) !== json
      );
    });
    const shiftJson = JSON.stringify(activeShift);
    if (changed.length === 0 && shiftJson === syncedShift.current) return;
    lastFloorChange.current = Date.now();
    setSyncState((current) => (current === "failed" ? current : "pending"));
    // One push at a time. A second one would be based on the revision the first is about to
    // replace, so the server would refuse it as a conflict and the waiter would lose taps.
    if (pushInFlight.current) {
      queuedBehindPush.current = true;
      return;
    }
    // Taps that waited for the last push to return have waited long enough.
    const delay = lastPushFailed.current ? FLOOR_RETRY_MS : queuedBehindPush.current ? 0 : FLOOR_PUSH_MS;
    queuedBehindPush.current = false;
    const timer = setTimeout(() => {
      pushInFlight.current = true;
      const payload = changed.map((session) => ({
        ...session,
        revision: syncRevisions.current.get(session.sessionId) ?? session.revision,
      }));
      fetch("/api/webroutes/pos/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        body: JSON.stringify({ sessions: payload, shift: activeShift, device: deviceId() }),
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("Sync rejected.");
          const result: unknown = await response.json();
          settlePush(
            changed,
            shiftJson,
            typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {}
          );
          lastPushFailed.current = false;
        })
        .catch(() => {
          lastPushFailed.current = true;
          setSyncState("failed");
        })
        .finally(() => {
          pushInFlight.current = false;
          setPushRound((round) => round + 1);
        });
    }, delay);
    return () => clearTimeout(timer);
  }, [sessions, activeShift, hydrated, syncAccount, pushRound]);

  // Other waiters write the same floor. Poll it while this screen is visible, and at once when
  // it becomes visible again.
  useEffect(() => {
    if (!hydrated || !syncAccount) return;
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pulling = false;

    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (!stop.signal.aborted && document.visibilityState === "visible") {
        timer = setTimeout(() => void pull(), delay);
      }
    };
    const pull = async () => {
      if (pulling) return;
      pulling = true;
      try {
        const since = floorVersion.current;
        const reply = await getJson(`/api/webroutes/pos/floor${since ? `?since=${since}` : ""}`, stop.signal);
        const heads = headList(reply.heads);
        if (heads) {
          lastFloorChange.current = Date.now();
          const ids = floorTablesToFetch(readFloor(), heads, syncRevisions.current);
          if (ids.length > 0) {
            const tables = await getJson(
              `/api/webroutes/pos/floor?ids=${ids.map(encodeURIComponent).join(",")}`,
              stop.signal
            );
            if (stop.signal.aborted) return;
            const remote = restorePosSessions(JSON.stringify(tables.sessions ?? [])).filter((session) =>
              isKnownOutlet(session.outletId)
            );
            const billNumbers = numberRecord(tables.billNumbers);
            setBillNumbers((current) => ({ ...current, ...billNumbers }));
            adoptServerCopies(remote, { announce: true });
          }
        }
        // Only now: a failed table fetch leaves the old version, so the next poll retries it.
        if (typeof reply.version === "string") floorVersion.current = reply.version;
      } catch {
        // A missed poll is not a failure: the next one, or the push, catches up.
      } finally {
        pulling = false;
      }
      schedule(floorPollDelay(lastFloorChange.current, Date.now()));
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void pull();
      else clearTimeout(timer);
    };

    document.addEventListener("visibilitychange", onVisibility);
    schedule(FLOOR_POLL_BUSY_MS);
    return () => {
      stop.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [hydrated, syncAccount, setBillNumbers]);

  return { syncAccount, syncState, syncMessage };
}
