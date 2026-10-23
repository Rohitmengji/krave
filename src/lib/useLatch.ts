import { useState } from "react";

/**
 * True from the first render where `value` is true, and forever after. Used to mount a lazy
 * dialog on first open and keep it mounted, so its state survives close and reopen exactly as
 * it did when the dialog was always mounted.
 */
export function useLatch(value: boolean): boolean {
  const [latched, setLatched] = useState(value);
  if (value && !latched) setLatched(true);
  return latched || value;
}
