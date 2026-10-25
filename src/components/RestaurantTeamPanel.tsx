"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import type { RestaurantTeam, TeamMember } from "@/lib/server/restaurantTeam";

type GrantableRole = "owner" | "manager" | "staff";

type Load =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; team: RestaurantTeam };

const ROLE_LABELS: Record<TeamMember["role"], string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  staff: "Waiter",
};

const GRANTABLE: GrantableRole[] = ["staff", "manager", "owner"];

function isGrantable(value: string): value is GrantableRole {
  return GRANTABLE.some((role) => role === value);
}

const ROLES: readonly string[] = ["owner", "admin", "manager", "staff"];

function isMember(value: unknown): value is TeamMember {
  if (typeof value !== "object" || value === null) return false;
  const member = value as Record<string, unknown>;
  return (
    typeof member.userId === "string" &&
    typeof member.email === "string" &&
    typeof member.displayName === "string" &&
    typeof member.role === "string" &&
    ROLES.includes(member.role) &&
    typeof member.you === "boolean"
  );
}

/** The reply is checked, not trusted: a half-formed list must not replace the real one. */
function teamFrom(value: unknown): RestaurantTeam | null {
  if (typeof value !== "object" || value === null) return null;
  const { members, canManage } = value as Record<string, unknown>;
  if (!Array.isArray(members) || typeof canManage !== "boolean") return null;
  return members.every(isMember) ? { members, canManage } : null;
}

function failureText(error: unknown, fallback: string): string {
  if (error instanceof DOMException || error instanceof TypeError) {
    return "Could not reach KRAVE. Check the connection and try again.";
  }
  return error instanceof Error ? error.message : fallback;
}

/**
 * Who may use this restaurant: waiters bill on the table POS, managers also run the menu and
 * orders, owners also change this list. People are added by the email of an account they
 * have already created, so the owner sees their name before granting anything.
 */
export function RestaurantTeamPanel({ restaurantId }: { restaurantId: string }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<GrantableRole>("staff");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const busyRef = useRef(false);
  const fieldId = useId();
  const url = `/api/owner/${encodeURIComponent(restaurantId)}/team`;

  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        const result: unknown = await response.json().catch(() => null);
        const team = response.ok ? teamFrom(result) : null;
        if (team) {
          setLoad({ status: "ready", team });
          return;
        }
        const reason = (result as { message?: unknown } | null)?.message;
        setLoad({
          status: "failed",
          message: typeof reason === "string" ? reason : "The team could not be loaded.",
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({ status: "failed", message: failureText(error, "The team could not be loaded.") });
      });
    return () => controller.abort();
  }, [url]);

  /** One change at a time; the reply is the whole team, so the list is never patched by hand. */
  async function change(
    method: "POST" | "DELETE",
    body: Record<string, string>,
    done: (team: RestaurantTeam) => string
  ): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify(body),
      });
      const result: unknown = await response.json().catch(() => null);
      const team = response.ok ? teamFrom(result) : null;
      if (!team) {
        const reason = (result as { message?: unknown } | null)?.message;
        throw new Error(typeof reason === "string" ? reason : "The team could not be changed. Try again.");
      }
      setLoad({ status: "ready", team });
      setMessage({ ok: true, text: done(team) });
      return true;
    } catch (error) {
      setMessage({ ok: false, text: failureText(error, "The team could not be changed. Try again.") });
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const address = email.trim().toLowerCase();
    const added = await change("POST", { email: address, role }, (team) => {
      const member = team.members.find((person) => person.email === address);
      return `${member?.displayName ?? address} now has ${ROLE_LABELS[role]} access.`;
    });
    if (added) setEmail("");
  }

  function setMemberRole(member: TeamMember, next: string) {
    if (!isGrantable(next) || next === member.role) return;
    void change("POST", { email: member.email, role: next }, () =>
      `${member.displayName} now has ${ROLE_LABELS[next]} access.`
    );
  }

  async function remove(member: TeamMember) {
    const removed = await change("DELETE", { userId: member.userId }, () =>
      `${member.displayName} no longer has access.`
    );
    if (removed) setConfirmingId(null);
  }

  const control =
    "min-h-11 rounded-xl border border-white/15 bg-[#0a0d12] px-3 text-base disabled:opacity-50";

  return (
    <section
      data-testid="restaurant-team"
      aria-labelledby="restaurant-team-heading"
      className="space-y-4 rounded-2xl border border-white/10 bg-[#121721] p-6"
    >
      <div>
        <h2 id="restaurant-team-heading" className="text-xl font-bold">Team</h2>
        <p className="mt-1 text-sm text-slate-400">
          Waiter: table POS only. Manager: also the menu, orders and settings. Owner: everything,
          including this list.
        </p>
      </div>

      {load.status === "loading" ? <p className="text-sm text-slate-400">Loading team…</p> : null}
      {load.status === "failed" ? (
        <p role="alert" className="text-sm text-rose-300">{load.message}</p>
      ) : null}

      {load.status === "ready" ? (
        <>
          <ul aria-label="People with access" className="divide-y divide-white/10">
            {load.team.members.map((member) => (
              <li key={member.userId} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-48 flex-1">
                  <p className="font-semibold">
                    {member.displayName}
                    {member.you ? <span className="text-slate-400"> (you)</span> : null}
                  </p>
                  <p className="break-all text-sm text-slate-400">{member.email}</p>
                </div>
                {!load.team.canManage || member.you ? (
                  <span className="rounded-full border border-white/15 px-3 py-1 text-sm font-semibold">
                    {ROLE_LABELS[member.role]}
                  </span>
                ) : confirmingId === member.userId ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-rose-200">Remove {member.displayName}&apos;s access?</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(member)}
                      className="min-h-11 rounded-xl bg-rose-700 px-4 font-bold disabled:opacity-50"
                    >
                      Remove access
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmingId(null)}
                      className="min-h-11 rounded-xl border border-white/20 px-4 font-bold disabled:opacity-50"
                    >
                      Keep
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label={`Role for ${member.displayName}`}
                      value={member.role}
                      disabled={busy}
                      onChange={(event) => setMemberRole(member, event.target.value)}
                      className={control}
                    >
                      {member.role === "admin" ? <option value="admin">Admin</option> : null}
                      <option value="staff">Waiter</option>
                      <option value="manager">Manager</option>
                      <option value="owner">Owner</option>
                    </select>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmingId(member.userId)}
                      aria-label={`Remove ${member.displayName}`}
                      className="min-h-11 rounded-xl border border-rose-300/40 px-4 font-bold text-rose-200 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>

          {load.team.canManage ? (
            <form onSubmit={add} className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
              <div className="space-y-1 text-sm">
                <label htmlFor={`${fieldId}-email`} className="block text-slate-300">
                  Email of their KRAVE account
                </label>
                <input
                  id={`${fieldId}-email`}
                  type="email"
                  inputMode="email"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  maxLength={160}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="waiter@example.com"
                  className={`w-full ${control}`}
                />
              </div>
              <div className="space-y-1 text-sm">
                <label htmlFor={`${fieldId}-role`} className="block text-slate-300">
                  Access
                </label>
                <select
                  id={`${fieldId}-role`}
                  value={role}
                  onChange={(event) => {
                    if (isGrantable(event.target.value)) setRole(event.target.value);
                  }}
                  className={`w-full ${control}`}
                >
                  <option value="staff">Waiter</option>
                  <option value="manager">Manager</option>
                  <option value="owner">Owner</option>
                </select>
              </div>
              <button
                disabled={busy}
                className="min-h-11 rounded-xl bg-emerald-600 px-5 font-bold disabled:opacity-50"
              >
                {busy ? "Saving…" : "Give access"}
              </button>
              <p className="text-xs text-slate-400 sm:col-span-3">
                They sign up on KRAVE with this email first. After you add them, they sign in and
                open the table POS.
              </p>
            </form>
          ) : (
            <p className="text-sm text-slate-400">Only an owner can change who has access.</p>
          )}
        </>
      ) : null}

      {message ? (
        <p
          role={message.ok ? "status" : "alert"}
          className={`text-sm ${message.ok ? "text-emerald-300" : "text-rose-300"}`}
        >
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
