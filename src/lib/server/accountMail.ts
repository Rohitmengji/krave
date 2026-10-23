import { readMailConfig, sendMail, type MailMessage } from "./mailer";
import {
  EMAIL_PARAGRAPH,
  EMAIL_SMALL,
  emailLayout,
  escapeHtml,
  type MailChannel,
} from "./passwordResetMail";
import type { EmailPurpose } from "./accountService";
import {
  ACCOUNT_PATH,
  EMAIL_CHANGE_LINK_MINUTES,
  emailLink,
  VERIFY_LINK_HOURS,
} from "@/lib/accountRules";

function button(href: string, label: string): string {
  return `<p style="margin:0 0 18px"><a href="${href}" style="display:inline-block;background:#047857;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:12px">${escapeHtml(label)}</a></p>`;
}

function fallbackLink(href: string, validity: string): string {
  return `<p style="${EMAIL_SMALL}">${escapeHtml(validity)} If the button doesn't open, copy this address into your browser:<br><span style="word-break:break-all">${href}</span></p>`;
}

export function verifyEmailMessage(to: string, link: string): MailMessage {
  const href = escapeHtml(link);
  const validity = `The link works once and expires in ${VERIFY_LINK_HOURS} hours.`;
  return {
    to,
    subject: "Confirm your KRAVE email address",
    text: [
      "Welcome to KRAVE. Confirm that this is your email address:",
      link,
      "",
      validity,
      "If you didn't create a KRAVE account, ignore this email.",
    ].join("\n"),
    html: emailLayout(
      "Confirm your email address",
      `<p style="${EMAIL_PARAGRAPH}">Welcome to KRAVE. Confirm that this is your email address, so you can always get back into your account.</p>
${button(href, "Confirm email address")}
${fallbackLink(href, validity)}
<p style="${EMAIL_SMALL}">If you didn't create a KRAVE account, ignore this email.</p>`
    ),
  };
}

export function emailChangeMessage(to: string, link: string, previousEmail: string): MailMessage {
  const href = escapeHtml(link);
  const validity = `The link works once and expires in ${EMAIL_CHANGE_LINK_MINUTES} minutes.`;
  return {
    to,
    subject: "Confirm your new KRAVE email address",
    text: [
      `Someone asked to move the KRAVE account ${previousEmail} to this address.`,
      `Confirm the change here: ${link}`,
      "",
      validity,
      "If this wasn't you, ignore this email. Nothing changes until the link is opened.",
    ].join("\n"),
    html: emailLayout(
      "Confirm your new email address",
      `<p style="${EMAIL_PARAGRAPH}">Someone asked to move the KRAVE account <strong>${escapeHtml(previousEmail)}</strong> to this address.</p>
${button(href, "Use this email address")}
${fallbackLink(href, validity)}
<p style="${EMAIL_SMALL}">If this wasn't you, ignore this email. Nothing changes until the link is opened.</p>`
    ),
  };
}

export function emailChangedNotice(to: string, newEmail: string, accountUrl: string): MailMessage {
  return {
    to,
    subject: "Your KRAVE email address was changed",
    text: [
      `Your KRAVE account now signs in with ${newEmail}. Emails will no longer come to this address.`,
      "",
      `If that was you, there is nothing to do. Your account: ${accountUrl}`,
      "",
      "If it wasn't you, reply to this email straight away: someone with your password moved your account.",
    ].join("\n"),
    html: emailLayout(
      "Your email address was changed",
      `<p style="${EMAIL_PARAGRAPH}">Your KRAVE account now signs in with <strong>${escapeHtml(newEmail)}</strong>. Emails will no longer come to this address.</p>
<p style="${EMAIL_PARAGRAPH}">If that was you, there is nothing to do.</p>
<p style="${EMAIL_SMALL}">If it wasn't you, reply to this email straight away: someone with your password moved your account.</p>`
    ),
  };
}

export function accountDeletedNotice(to: string): MailMessage {
  return {
    to,
    subject: "Your KRAVE account was deleted",
    text: [
      "Your KRAVE account and its orders, bookings, bookmarks and notifications were deleted.",
      "",
      "If you didn't do this, reply to this email.",
    ].join("\n"),
    html: emailLayout(
      "Your account was deleted",
      `<p style="${EMAIL_PARAGRAPH}">Your KRAVE account and its orders, bookings, bookmarks and notifications were deleted.</p>
<p style="${EMAIL_SMALL}">If you didn't do this, reply to this email.</p>`
    ),
  };
}

/** Sends a verification or change link, or writes it to the log in development. */
export async function deliverEmailLink(
  channel: MailChannel,
  purpose: EmailPurpose,
  to: string,
  token: string,
  previousEmail: string
): Promise<void> {
  const link = emailLink(channel.origin, token);
  if (channel.kind === "server-log") {
    console.info(`[krave] ${purpose === "verify" ? "email confirmation" : "email change"} link for ${to}: ${link}`);
    return;
  }
  await sendMail(
    purpose === "verify" ? verifyEmailMessage(to, link) : emailChangeMessage(to, link, previousEmail)
  );
}

export async function notifyEmailChanged(
  previousEmail: string,
  newEmail: string,
  origin: string
): Promise<void> {
  if (!readMailConfig()) return;
  await sendMail(emailChangedNotice(previousEmail, newEmail, `${origin}${ACCOUNT_PATH}`));
}

export async function notifyAccountDeleted(email: string): Promise<void> {
  if (!readMailConfig()) return;
  await sendMail(accountDeletedNotice(email));
}
