import { rows, run } from "./pg";

export interface AuditEntry {
  id: number;
  actorId: string;
  action: string;
  subject: string;
  detail: string;
  at: string;
}

/**
 * Append-only by database trigger, not just by this module. Nothing here can edit
 * or remove an entry, because no such function exists.
 */
export async function recordAudit(
  actorId: string,
  action: string,
  subject: string,
  detail: string,
  now = new Date()
): Promise<void> {
  await run(
    "INSERT INTO audit_log (actor_id, action, subject, detail, at) VALUES ($1, $2, $3, $4, $5)",
    [actorId, action, subject, detail.slice(0, 600), now.toISOString()]
  );
}

export async function listAudit(subject: string): Promise<AuditEntry[]> {
  const found = await rows<Record<string, unknown>>(
    "SELECT * FROM audit_log WHERE subject = $1 ORDER BY at DESC, id DESC LIMIT 100",
    [subject]
  );

  return found.map((row) => ({
    id: Number(row.id),
    actorId: String(row.actor_id),
    action: String(row.action),
    subject: String(row.subject),
    detail: String(row.detail),
    at: String(row.at),
  }));
}
