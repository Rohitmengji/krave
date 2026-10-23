import nodemailer from "nodemailer";

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface MailConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly requireTLS: boolean;
  readonly auth: { readonly user: string; readonly pass: string } | null;
  readonly from: string | { readonly name: string; readonly address: string };
}

/** A half-finished SMTP setup. Not a plain Error, so a route answers 500 and logs it. */
export class MailConfigError extends Error {
  override name = "MailConfigError";
}

type Env = Readonly<Record<string, string | undefined>>;

/** Null when SMTP_HOST is unset, meaning this deployment sends no email at all. */
export function readMailConfig(env: Env = process.env): MailConfig | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;

  const portText = env.SMTP_PORT?.trim() || "587";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    throw new MailConfigError("SMTP_PORT must be a port number.");
  }
  const user = env.SMTP_USER?.trim() ?? "";
  const pass = env.SMTP_PASS ?? "";
  if (Boolean(user) !== Boolean(pass)) {
    throw new MailConfigError("Set both SMTP_USER and SMTP_PASS, or neither.");
  }
  const from = env.EMAIL_FROM?.trim() ?? "";
  if (!from && !user) {
    throw new MailConfigError("Set EMAIL_FROM when the SMTP server takes no login.");
  }

  const secure = port === 465;
  return {
    host,
    port,
    secure,
    // Without implicit TLS, a login is only sent after STARTTLS succeeds, never in clear text.
    requireTLS: !secure && Boolean(user),
    auth: user ? { user, pass } : null,
    from: from || { name: "KRAVE", address: user },
  };
}

export async function sendMail(
  message: MailMessage,
  config: MailConfig | null = readMailConfig()
): Promise<void> {
  if (!config) throw new MailConfigError("Email is not configured.");
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: config.requireTLS,
    auth: config.auth ?? undefined,
    // A stalled relay must not hold a serverless instance open.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  try {
    await transport.sendMail({
      from: config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  } finally {
    transport.close();
  }
}
