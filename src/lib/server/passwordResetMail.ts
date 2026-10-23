import { createPasswordReset } from "./auth";
import { readMailConfig, sendMail, type MailMessage } from "./mailer";
import { RESET_LINK_MINUTES, resetLink, SIGN_IN_PATH } from "@/lib/passwordReset";

type Env = Readonly<Record<string, string | undefined>>;

export type ResetChannel =
  | { readonly kind: "email"; readonly origin: string }
  | { readonly kind: "server-log"; readonly origin: string };

function configuredOrigin(env: Env): string | null {
  const vercelHost = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const configured = env.KRAVE_PUBLIC_URL?.trim() || (vercelHost ? `https://${vercelHost}` : "");
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
  } catch {
    // Reported below with the variable name, which is what the operator needs.
  }
  console.error("[krave] KRAVE_PUBLIC_URL must be an http(s) address; reset links are disabled.");
  return null;
}

/**
 * Where links in account emails point. In production this is never the request's Host
 * header: a forged Host would have us mail a real customer a live token on someone else's site.
 */
export function publicOrigin(requestOrigin: string, env: Env = process.env): string | null {
  if (env.KRAVE_PUBLIC_URL?.trim() || env.VERCEL_PROJECT_PRODUCTION_URL?.trim()) {
    return configuredOrigin(env);
  }
  return env.NODE_ENV === "production" ? null : requestOrigin;
}

/** How a reset link would reach its owner here, or null when it cannot reach them at all. */
export function resetChannel(requestOrigin: string, env: Env = process.env): ResetChannel | null {
  const mail = readMailConfig(env);
  const origin = publicOrigin(requestOrigin, env);
  if (!origin) {
    if (mail) console.error("[krave] Set KRAVE_PUBLIC_URL so reset emails can link back here.");
    return null;
  }
  if (mail) return { kind: "email", origin };
  // Without a mail server only development has a channel: its own terminal.
  return env.NODE_ENV === "production" ? null : { kind: "server-log", origin };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function layout(heading: string, body: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px">
<p style="margin:0 0 16px;font-size:20px;font-weight:900;color:#047857">KRAVE</p>
<h1 style="margin:0 0 12px;font-size:18px">${escapeHtml(heading)}</h1>
${body}
</div></body></html>`;
}

const PARAGRAPH = "margin:0 0 14px;font-size:15px;line-height:1.6";
const SMALL = "margin:0 0 14px;font-size:13px;line-height:1.6;color:#475569";

export function passwordResetMessage(to: string, link: string): MailMessage {
  const href = escapeHtml(link);
  return {
    to,
    subject: "Reset your KRAVE password",
    text: [
      "Someone asked to reset the password for your KRAVE account.",
      "",
      `Choose a new password here. The link works once and expires in ${RESET_LINK_MINUTES} minutes:`,
      link,
      "",
      "If this wasn't you, ignore this email. Your password stays the same.",
    ].join("\n"),
    html: layout(
      "Reset your password",
      `<p style="${PARAGRAPH}">Someone asked to reset the password for your KRAVE account.</p>
<p style="margin:0 0 18px"><a href="${href}" style="display:inline-block;background:#047857;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:12px">Choose a new password</a></p>
<p style="${SMALL}">The link works once and expires in ${RESET_LINK_MINUTES} minutes. If the button doesn't open, copy this address into your browser:<br><span style="word-break:break-all">${href}</span></p>
<p style="${SMALL}">If this wasn't you, ignore this email. Your password stays the same.</p>`
    ),
  };
}

export function passwordChangedMessage(to: string, signInUrl: string): MailMessage {
  const href = escapeHtml(signInUrl);
  return {
    to,
    subject: "Your KRAVE password was changed",
    text: [
      "The password for your KRAVE account was just changed, and every device was signed out.",
      "",
      `If that was you, sign in with the new password: ${signInUrl}`,
      "",
      "If it wasn't you, choose \"Forgot password?\" on the sign-in screen to take the account back, and change your email password too.",
    ].join("\n"),
    html: layout(
      "Your password was changed",
      `<p style="${PARAGRAPH}">The password for your KRAVE account was just changed, and every device was signed out.</p>
<p style="${PARAGRAPH}">If that was you, <a href="${href}" style="color:#047857;font-weight:700">sign in with the new password</a>.</p>
<p style="${SMALL}">If it wasn't you, choose "Forgot password?" on the sign-in screen to take the account back, and change your email password too.</p>`
    ),
  };
}

/**
 * Issues a token and sends it. Runs after the response, so an unknown address (no token, no
 * email) answers exactly as fast as a known one.
 */
export async function deliverPasswordReset(email: string, channel: ResetChannel): Promise<void> {
  const reset = await createPasswordReset({ email });
  if (!reset) return;
  const link = resetLink(channel.origin, reset.token);
  if (channel.kind === "server-log") {
    console.info(`[krave] password reset link (expires ${reset.expiresAt.toISOString()}): ${link}`);
    return;
  }
  await sendMail(passwordResetMessage(email, link));
}

/** Tells the owner their password changed, so a reset they did not make does not go unseen. */
export async function notifyPasswordChanged(email: string, origin: string): Promise<void> {
  if (!readMailConfig()) return;
  await sendMail(passwordChangedMessage(email, `${origin}${SIGN_IN_PATH}`));
}
