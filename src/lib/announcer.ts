/**
 * Screen-reader announcements that survive modal dialogs.
 *
 * While a modal is open the browser makes everything outside it inert, including a toast
 * popover in the top layer, so a `role="status"` toast is dropped from the accessibility
 * tree. Each open dialog therefore owns a live region, and messages go to the topmost one,
 * or to the page's region when no modal is open. Regions exist before their text changes,
 * which is what screen readers reliably announce; a node inserted with its text is not.
 */

export const PAGE_ANNOUNCER_ID = "krave-announcer";

// Topmost last. Kept in open order, which is the browser's top-layer order.
const modalRegions: HTMLElement[] = [];

export function registerModalRegion(region: HTMLElement): () => void {
  modalRegions.push(region);
  return () => {
    const index = modalRegions.lastIndexOf(region);
    if (index >= 0) modalRegions.splice(index, 1);
  };
}

type Timers = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (id: never) => void;
};

let pending: unknown = null;

function currentRegion(doc: Pick<Document, "getElementById">): HTMLElement | null {
  return modalRegions.at(-1) ?? doc.getElementById(PAGE_ANNOUNCER_ID);
}

/**
 * Clears the region now and writes the message on the next tick, so the same text twice is
 * still a change. The target is resolved again at write time: a dialog that closed in
 * between hands the message to whatever is now on top. A newer message replaces a pending one.
 */
export function announce(
  message: string,
  doc: Pick<Document, "getElementById"> = document,
  timers: Timers = globalThis as unknown as Timers
): void {
  if (pending !== null) timers.clearTimeout(pending as never);
  const before = currentRegion(doc);
  if (before) before.textContent = "";
  pending = timers.setTimeout(() => {
    pending = null;
    const region = currentRegion(doc);
    if (region) region.textContent = message;
  }, 60);
}
