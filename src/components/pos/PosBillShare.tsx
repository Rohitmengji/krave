"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { FileText, Mail } from "lucide-react";
import { normalizeIndianMobile } from "@/lib/pos/posEngine";
import { SendBill } from "./SendBill";

const BILL_NOT_SAVED = /not saved yet/i;

/**
 * The customer's mobile typed straight into the bill: WhatsApp and SMS appear as soon as it is
 * a real number, so sending is type, tap. `onSend` lets the table keep the number for later.
 */
export function SendToNumber({
  text,
  label,
  testId,
  numberTestId,
  onSend,
}: {
  text: string;
  label: string;
  testId: string;
  numberTestId: string;
  onSend?: (phone: string) => void;
}) {
  const fieldId = useId();
  const [number, setNumber] = useState("");
  const phone = normalizeIndianMobile(number);
  return (
    <div className="space-y-1.5 rounded-xl border border-dashed border-black/30 p-2 font-sans">
      <label htmlFor={fieldId} className="block text-xs font-bold text-black">
        Customer&apos;s mobile for WhatsApp or SMS
      </label>
      <input
        id={fieldId}
        type="tel"
        inputMode="tel"
        autoComplete="off"
        maxLength={16}
        data-testid={numberTestId}
        value={number}
        onChange={(event) => setNumber(event.target.value)}
        placeholder="10-digit mobile"
        aria-describedby={phone ? undefined : `${fieldId}-hint`}
        className="min-h-11 w-full rounded-lg border border-black/30 px-2.5 text-sm text-black"
      />
      {phone ? (
        <SendBill phone={phone} text={text} label={label} testId={testId} onSend={() => onSend?.(phone)} />
      ) : (
        <p
          id={`${fieldId}-hint`}
          className={`text-xs ${number.trim() ? "font-bold text-red-700" : "text-black/60"}`}
        >
          {number.trim() ? "Enter a 10-digit Indian mobile number." : "Type the number, then tap WhatsApp or SMS."}
        </p>
      )}
    </div>
  );
}

/**
 * The guest's PDF link for a table, fetched while its bill is on screen. A table settled a
 * moment ago may still be on its way to the server, so a "not saved yet" answer is retried
 * for half a minute; anything else (signed out, no access) is left alone. Null until ready.
 */
export function useBillLink(sessionId: string | null, signedIn: boolean): string | null {
  const [link, setLink] = useState<{ sessionId: string; url: string } | null>(null);

  useEffect(() => {
    if (!sessionId || !signedIn) return;
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const attempt = async () => {
      attempts += 1;
      let retry = true;
      try {
        const response = await fetch("/api/pos/bill-link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
          signal: stop.signal,
        });
        const result: unknown = await response.json().catch(() => null);
        const body = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
        if (response.ok && typeof body.url === "string") {
          setLink({ sessionId, url: body.url });
          return;
        }
        retry = typeof body.message === "string" && BILL_NOT_SAVED.test(body.message);
      } catch {
        if (stop.signal.aborted) return;
      }
      if (retry && attempts < 10) timer = setTimeout(() => void attempt(), 3000);
    };
    void attempt();
    return () => {
      stop.abort();
      clearTimeout(timer);
    };
  }, [sessionId, signedIn]);

  return link && link.sessionId === sessionId ? link.url : null;
}

type EmailState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "sent"; to: string }
  | { status: "failed"; message: string };

/**
 * Email the bill as a PDF straight from the server, or open the PDF to print or share it.
 * The address is asked for only when Email is tapped, and kept for a resend.
 */
export function BillEmailAndPdf({
  sessionId,
  link,
  signedIn,
  mailEnabled,
  testId,
}: {
  sessionId: string;
  link: string | null;
  signedIn: boolean;
  /** False when this deployment has no SMTP: the button would only ever fail. */
  mailEnabled: boolean;
  testId: string;
}) {
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [state, setState] = useState<EmailState>({ status: "idle" });
  const sending = useRef(false);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (sending.current) return;
    sending.current = true;
    setState({ status: "sending" });
    try {
      const response = await fetch("/api/pos/bill-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ sessionId, email: email.trim() }),
      });
      const result: unknown = await response.json().catch(() => null);
      const body = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
      if (!response.ok || typeof body.sentTo !== "string") {
        throw new Error(typeof body.message === "string" ? body.message : "The email could not be sent. Try again.");
      }
      setState({ status: "sent", to: body.sentTo });
      setOpen(false);
    } catch (error) {
      setState({
        status: "failed",
        message:
          error instanceof DOMException || error instanceof TypeError
            ? "No connection. Check the internet and try again."
            : error instanceof Error
              ? error.message
              : "The email could not be sent. Try again.",
      });
    } finally {
      sending.current = false;
    }
  }

  const button =
    "flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-3 font-sans text-xs font-black";

  return (
    <div className="space-y-1.5 font-sans">
      <div className={`grid gap-1.5 ${mailEnabled ? "grid-cols-2" : "grid-cols-1"}`}>
        {mailEnabled && (
          <button
            type="button"
            data-testid={`${testId}-email-open`}
            aria-expanded={open}
            disabled={!signedIn}
            onClick={() => setOpen((current) => !current)}
            className={`${button} bg-slate-800 text-white hover:bg-slate-700 disabled:opacity-50`}
          >
            <Mail className="h-4 w-4 shrink-0" aria-hidden="true" />
            Email
          </button>
        )}
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`${testId}-pdf`}
            className={`${button} border border-black/25 text-black hover:bg-black/5`}
          >
            <FileText className="h-4 w-4 shrink-0" aria-hidden="true" />
            PDF bill
          </a>
        ) : (
          <span
            aria-disabled="true"
            className={`${button} border border-black/15 text-black/60`}
            title={signedIn ? "Getting the PDF ready…" : "Sign in to make a PDF link"}
          >
            <FileText className="h-4 w-4 shrink-0" aria-hidden="true" />
            {signedIn ? "PDF…" : "PDF bill"}
          </span>
        )}
      </div>

      {open && (
        <form onSubmit={send} className="space-y-1.5 rounded-xl border border-black/15 p-2">
          <label htmlFor={fieldId} className="block text-xs font-bold text-black">
            Customer&apos;s email
          </label>
          <input
            id={fieldId}
            type="email"
            inputMode="email"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            required
            maxLength={160}
            data-testid={`${testId}-email`}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@example.com"
            className="min-h-11 w-full rounded-lg border border-black/30 px-2.5 text-sm text-black"
          />
          <button
            type="submit"
            data-testid={`${testId}-email-send`}
            disabled={state.status === "sending"}
            className={`${button} w-full bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-60`}
          >
            {state.status === "sending" ? "Sending…" : "Send bill (PDF)"}
          </button>
        </form>
      )}

      {state.status === "sent" && (
        <p role="status" data-testid={`${testId}-email-sent`} className="text-xs font-bold text-emerald-800">
          Bill emailed to {state.to}.
        </p>
      )}
      {state.status === "failed" && (
        <p role="alert" className="text-xs font-bold text-red-700">
          {state.message}
        </p>
      )}
    </div>
  );
}
