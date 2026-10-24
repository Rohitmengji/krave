import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Where the suite's SMTP sink (global-setup.ts) writes each message, one JSON file apiece. */
export const MAILBOX_DIR = path.resolve(".e2e-mail");
export const MAIL_SINK_PORT = Number(process.env.KRAVE_E2E_SMTP_PORT || 2525);

interface StoredMail {
  to: string[];
  raw: string;
}

function isStoredMail(value: unknown): value is StoredMail {
  const mail = value as { to?: unknown; raw?: unknown } | null;
  return Array.isArray(mail?.to) && typeof mail?.raw === "string";
}

/** Every message the sink accepted for this address, oldest first. */
export function mailTo(address: string): StoredMail[] {
  let files: string[];
  try {
    files = readdirSync(MAILBOX_DIR).filter((file) => file.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return files
    .map((file): unknown => JSON.parse(readFileSync(path.join(MAILBOX_DIR, file), "utf8")))
    .filter(isStoredMail)
    .filter((mail) => mail.to.includes(address.toLowerCase()));
}

/** Long lines arrive quoted-printable: soft breaks and escaped "=" would split the link. */
function decodeQuotedPrintable(raw: string): string {
  return raw
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

export function subjectsFor(address: string): string[] {
  return mailTo(address).map((mail) => /^Subject: (.*)$/m.exec(mail.raw)?.[1]?.trim() ?? "");
}

export function latestResetLink(address: string): string | null {
  const mail = mailTo(address)
    .filter((candidate) => /^Subject: Reset your KRAVE PIN/m.test(candidate.raw))
    .at(-1);
  if (!mail) return null;
  return (
    /https?:\/\/[^\s"<>]+\/reset-password#token=[A-Za-z0-9_-]+/.exec(
      decodeQuotedPrintable(mail.raw)
    )?.[0] ?? null
  );
}

/** The newest email-confirmation or address-change link sent to this address. */
export function latestConfirmLink(address: string): string | null {
  const mail = mailTo(address)
    .filter((candidate) => /^Subject: Confirm your (new )?KRAVE email address/m.test(candidate.raw))
    .at(-1);
  if (!mail) return null;
  return (
    /https?:\/\/[^\s"<>]+\/verify-email#token=[A-Za-z0-9_-]+/.exec(decodeQuotedPrintable(mail.raw))?.[0] ??
    null
  );
}
