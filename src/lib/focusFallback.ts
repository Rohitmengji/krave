type Focusable = { isConnected: boolean; focus(options?: FocusOptions): void };
type FocusDocument = { activeElement: Element | null; body: HTMLElement | null };
type Container = { contains(node: Node | null): boolean };

/**
 * A closed dialog hands focus back to whatever opened it. When that opener has since
 * been removed (the checkout drawer that placed the order), the browser leaves focus on
 * the control inside the closing dialog, which React detaches next, so it lands on
 * <body> and keyboard users are sent back to the top of the page. Only then move it to
 * the fallback; focus the browser restored itself is left alone.
 */
export function refocusIfDropped(
  doc: FocusDocument,
  fallback: Focusable | null | undefined,
  closing?: Container | null
): boolean {
  const active = doc.activeElement;
  const dropped = active === null || active === doc.body || Boolean(closing?.contains(active));
  if (!dropped || !fallback?.isConnected) return false;
  fallback.focus({ preventScroll: true });
  return true;
}
