import { useSyncExternalStore } from "react";

const MINUTE_MS = 60_000;

function subscribe(onTick: () => void) {
  const timer = window.setInterval(onTick, 15_000);
  // A laptop waking from sleep should not keep offering slots that passed meanwhile.
  document.addEventListener("visibilitychange", onTick);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onTick);
  };
}

// Floored to the minute so the snapshot is stable between ticks and React re-renders once a minute.
const currentMinute = () => Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
const unknownOnServer = () => null;

/**
 * The current time to the minute, or null during the server render and hydration, so anything
 * derived from the clock cannot cause a hydration mismatch.
 */
export function useMinuteClock(): number | null {
  return useSyncExternalStore(subscribe, currentMinute, unknownOnServer);
}
