import { getDb } from "./db";

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
export function recordAudit(
  actorId: string,
  action: string,
  subject: string,
  detail: string,
  now = new Date()
): void {
  getDb()
    .prepare(
      "INSERT INTO audit_log (actor_id, action, subject, detail, at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(actorId, action, subject, detail.slice(0, 600), now.toISOString());
}

export function listAudit(subject: string): AuditEntry[] {
  const rows = getDb()
    .prepare("SELECT * FROM audit_log WHERE subject = ? ORDER BY at DESC, id DESC LIMIT 100")
    .all(subject) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: Number(row.id),
    actorId: String(row.actor_id),
    action: String(row.action),
    subject: String(row.subject),
    detail: String(row.detail),
    at: String(row.at),
  }));
}
