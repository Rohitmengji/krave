/**
 * Class names for terminal dialogs built on OverlayDialog. A native dialog takes the
 * system text colour, so each sets its own: white on the dark forms, black on the paper
 * (bill, kitchen ticket, Z-report) that prints.
 */
export const POS_FORM_DIALOG =
  "pos-no-print m-auto w-full max-w-sm bg-transparent p-4 text-white backdrop:bg-black/80";

export const POS_PAPER_DIALOG =
  "m-auto w-full max-w-xs bg-transparent p-4 text-black backdrop:bg-black/80";

/** The X in a dark dialog's header, at the terminal's 44px touch size. */
export const POS_CLOSE_BUTTON =
  "flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg hover:bg-white/10";
