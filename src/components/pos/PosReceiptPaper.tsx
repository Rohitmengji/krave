import React from "react";
import type { PosBill, PosTableSession } from "@/lib/pos/posEngine";

function formatMoney(value: number): string {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** The printed part of a bill: what goes to the thermal printer and what the guest keeps. */
export function PosReceiptPaper({
  session,
  bill,
  billNumber,
  claimCode,
}: {
  session: PosTableSession;
  bill: PosBill;
  billNumber: number | null;
  claimCode: string | null;
}) {
  const paidAt = session.payment ? new Date(session.payment.settledAt) : null;
  return (
    <>
      <div className="text-center">
        <div className="text-sm font-black">{session.outletName}</div>
        <div>{session.status === "SETTLED" ? "BILL · PAID" : "BILL"}</div>
        {billNumber !== null && (
          <div data-testid="pos-receipt-bill-number" className="font-black">
            Bill No. {billNumber}
          </div>
        )}
        <div>
          Table {session.tableId} · {session.guestCount} guests
        </div>
        <div>Server: {session.serverName}</div>
        <div>{(paidAt ?? new Date(session.openedAt)).toLocaleString("en-IN")}</div>
      </div>

      <hr className="my-2 border-dashed border-black/40" />

      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className="font-bold">Item</th>
            <th className="w-8 text-center font-bold">Qty</th>
            <th className="w-16 text-right font-bold">Amount</th>
          </tr>
        </thead>
        <tbody>
          {session.lines.map((line) => (
            <tr key={line.lineId}>
              <td className="pr-1 align-top">{line.name}</td>
              <td className="text-center align-top">{line.quantity}</td>
              <td className="text-right align-top">{formatMoney(line.unitPrice * line.quantity)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <hr className="my-2 border-dashed border-black/40" />

      <div className="space-y-0.5">
        <div className="flex justify-between">
          <span>Subtotal</span>
          <span>{formatMoney(bill.subtotal)}</span>
        </div>
        {bill.discountAmount > 0 && (
          <div className="flex justify-between">
            <span>Discount ({session.discountPercent}%)</span>
            <span>−{formatMoney(bill.discountAmount)}</span>
          </div>
        )}
        {bill.serviceCharge > 0 && (
          <div className="flex justify-between">
            <span>Service ({session.serviceChargePercent}%)</span>
            <span>{formatMoney(bill.serviceCharge)}</span>
          </div>
        )}
        {bill.cgstRateBps + bill.sgstRateBps > 0 && (
          <>
            <div className="flex justify-between">
              <span>CGST {bill.cgstRateBps / 100}%</span>
              <span>{formatMoney(bill.cgst)}</span>
            </div>
            <div className="flex justify-between">
              <span>SGST {bill.sgstRateBps / 100}%</span>
              <span>{formatMoney(bill.sgst)}</span>
            </div>
          </>
        )}
        <div className="flex justify-between">
          <span>Round off</span>
          <span>{formatMoney(bill.roundOff)}</span>
        </div>
        <div className="flex justify-between border-t border-black/40 pt-1 text-sm font-black">
          <span>TOTAL</span>
          <span>₹{bill.grandTotal}</span>
        </div>
        {session.guestCount > 1 && (
          <div className="flex justify-between">
            <span>Per guest</span>
            <span>₹{bill.perGuest}</span>
          </div>
        )}
      </div>

      {session.payment && (
        <>
          <hr className="my-2 border-dashed border-black/40" />
          <div className="space-y-0.5">
            <div className="flex justify-between">
              <span>Paid by</span>
              <span>{session.payment.method}</span>
            </div>
            <div className="flex justify-between">
              <span>Tendered</span>
              <span>₹{session.payment.amountTendered}</span>
            </div>
            <div className="flex justify-between">
              <span>Change</span>
              <span>₹{session.payment.changeDue}</span>
            </div>
          </div>
        </>
      )}

      {session.corrections.length > 0 && (
        <div
          data-testid="pos-receipt-corrections"
          className="mt-2 space-y-0.5 border-t border-dashed border-black/40 pt-1 text-[10px]"
        >
          {session.corrections.map((correction, index) => (
            <div key={`${correction.at}-${index}`}>
              Corrected{" "}
              {new Date(correction.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
              : {correction.detail}
              {correction.reason ? ` — ${correction.reason}` : ""}
            </div>
          ))}
        </div>
      )}

      <p className="mt-3 text-center">Thank you! Please visit again.</p>
      {session.status === "SETTLED" && claimCode && (
        <div className="mt-3 border-t border-dashed border-black/40 pt-2 text-center">
          <div className="text-[9px] uppercase tracking-wide">Add this bill to your Krave account</div>
          <div data-testid="pos-receipt-claim-code" className="text-base font-black tracking-[0.2em]">
            {claimCode}
          </div>
          <div className="text-[9px]">Enter it under Your Orders. Valid for 30 days.</div>
        </div>
      )}
      {bill.taxTotal > 0 && (
        <p className="mt-1 text-center text-[9px]">
          Not a GST tax invoice: no GSTIN is on record for this restaurant.
        </p>
      )}
    </>
  );
}
