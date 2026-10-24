/**
 * Operator mailboxes that may create restaurants and grant owner access, in addition to
 * KRAVE_STAFF_EMAILS and KRAVE_RESTAURANT_ADMIN_EMAILS.
 *
 * jagadamba@krave.com is the Jagadamba owner account. Signing up with it (a 6 to 8 digit PIN)
 * is enough to open the restaurant workspace and grant access to other accounts. The address
 * is unique, so only the first signup can hold it.
 */
export const DESIGNATED_OWNER_EMAILS = ["jagadamba@krave.com"] as const;

export function isDesignatedOwnerEmail(email: string): boolean {
  return (DESIGNATED_OWNER_EMAILS as readonly string[]).includes(email.trim().toLowerCase());
}
