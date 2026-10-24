"use client";

import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Copy, MessageCircle, MessageSquare, QrCode } from "lucide-react";
import { smsHref, smsQrPayload, smsSegments, whatsAppHref } from "@/lib/pos/billSms";

const noSubscription = () => () => {};
const isPhone = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** Only a phone has a SIM to send from; a laptop at the counter hands the SMS to one. */
function useCanTextFromThisDevice(): boolean {
  return useSyncExternalStore(noSubscription, isPhone, () => false);
}

/**
 * Send a bill as an SMS from the restaurant's own SIM, or on WhatsApp. On a phone the SMS
 * button opens its messaging app with the number and text filled in. On a laptop, where an
 * `sms:` link does nothing, it shows a QR code: scanning it with the phone's camera opens
 * that phone's messaging app the same way.
 */
export function SendBill({
  phone,
  text,
  label,
  testId,
}: {
  phone: string;
  text: string;
  label: string;
  testId: string;
}) {
  const canText = useCanTextFromThisDevice();
  const [handoffOpen, setHandoffOpen] = useState(false);
  const segments = smsSegments(text);
  const cost = segments === 1 ? "1 SMS" : `${segments} SMS`;
  const primary =
    "flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl bg-sky-600 px-3 py-2 font-sans text-xs font-black text-white hover:bg-sky-500";

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-1.5">
        {canText ? (
          <a href={smsHref(phone, text)} data-testid={testId} className={primary}>
            <MessageSquare className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{label}</span>
          </a>
        ) : (
          <button
            type="button"
            data-testid={`${testId}-open`}
            aria-expanded={handoffOpen}
            onClick={() => setHandoffOpen((open) => !open)}
            className={primary}
          >
            <QrCode className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{label}</span>
          </button>
        )}
        <a
          href={whatsAppHref(phone, text)}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`${testId}-whatsapp`}
          aria-label={`WhatsApp: ${label}`}
          className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-[#128C4A] px-3 font-sans text-xs font-black text-white hover:bg-[#0f7a40]"
        >
          <MessageCircle className="h-4 w-4" aria-hidden="true" />
          WhatsApp
        </a>
      </div>
      <p className="font-sans text-[11px] opacity-60">
        {canText
          ? `SMS goes from this phone's SIM (${cost}).`
          : `This computer has no SIM: tap SMS to send it from your phone (${cost}).`}
      </p>
      {!canText && handoffOpen && <SmsHandoff phone={phone} text={text} cost={cost} testId={testId} />}
    </div>
  );
}

function SmsHandoff({
  phone,
  text,
  cost,
  testId,
}: {
  phone: string;
  text: string;
  cost: string;
  testId: string;
}) {
  const [qr, setQr] = useState<{ size: number; path: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Loaded only when a laptop needs it, so phones never download the encoder.
    import("qrcode")
      .then(({ default: QRCode }) => {
        const { modules } = QRCode.create(smsQrPayload(phone, text), { errorCorrectionLevel: "M" });
        let path = "";
        for (let row = 0; row < modules.size; row += 1) {
          for (let col = 0; col < modules.size; col += 1) {
            if (modules.get(row, col)) path += `M${col} ${row}h1v1h-1z`;
          }
        }
        if (!cancelled) setQr({ size: modules.size, path });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [phone, text]);

  return (
    <div
      data-testid={`${testId}-handoff`}
      className="space-y-2 rounded-xl border border-black/10 bg-white p-3 font-sans text-black"
    >
      <div className="flex flex-col items-center gap-2">
        {qr ? (
          <svg
            viewBox={`-2 -2 ${qr.size + 4} ${qr.size + 4}`}
            className="h-44 w-44"
            role="img"
            aria-label="QR code that opens this SMS on a phone"
            shapeRendering="crispEdges"
          >
            <rect x={-2} y={-2} width={qr.size + 4} height={qr.size + 4} fill="#fff" />
            <path d={qr.path} fill="#000" />
          </svg>
        ) : (
          <div className="h-44 w-44 animate-pulse rounded bg-black/5" />
        )}
        <ol className="w-full list-decimal space-y-0.5 pl-5 text-xs leading-snug">
          <li>Open the camera on the phone that has your SIM.</li>
          <li>Point it at this code and tap the message link.</li>
          <li>Messages opens with the bill typed in. Tap Send ({cost}).</li>
        </ol>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={() =>
            navigator.clipboard
              ?.writeText(text)
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }
          className="flex min-h-11 items-center justify-center gap-1 rounded-lg border border-black/20 text-xs font-bold"
        >
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          {copied ? "Copied" : "Copy message"}
        </button>
        <a
          href={smsHref(phone, text)}
          data-testid={testId}
          className="flex min-h-11 items-center justify-center rounded-lg border border-black/20 text-center text-xs font-bold"
        >
          Messages on this computer
        </a>
      </div>
    </div>
  );
}
