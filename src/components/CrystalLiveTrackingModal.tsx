"use client";

import React, { useEffect, useRef } from "react";
import {
  X,
  Bike,
  CheckCircle2,
  PhoneCall,
  ShieldCheck,
  Clock,
  MapPin,
  Store,
  FastForward,
} from "lucide-react";
import {
  BrandThemePreset,
  CrystalOrderStage,
  CrystalOrderState,
} from "@/types/krave";

interface CrystalLiveTrackingModalProps {
  order: CrystalOrderState | null;
  theme: BrandThemePreset;
  isDark: boolean;
  onClose: () => void;
  onAdvanceStage: () => void;
}

const STAGE_SEQUENCE: {
  stage: CrystalOrderStage;
  label: string;
  subtitle: string;
  eta: number;
  progress: number;
}[] = [
  {
    stage: "ORDER_CONFIRMED",
    label: "Order Confirmed by Kitchen",
    subtitle: "The restaurant has accepted your order and started prep.",
    eta: 24,
    progress: 18,
  },
  {
    stage: "KITCHEN_PREPARING",
    label: "Chef is Preparing Your Meal",
    subtitle: "Freshly cooked and packed with a tamper-evident hygiene seal.",
    eta: 18,
    progress: 42,
  },
  {
    stage: "RIDER_ASSIGNED",
    label: "Delivery Partner Arrived at Kitchen",
    subtitle: "Your delivery partner is picking up your order.",
    eta: 12,
    progress: 65,
  },
  {
    stage: "OUT_FOR_DELIVERY",
    label: "On the Way to Your Location",
    subtitle: "Your order is en route to your selected address.",
    eta: 5,
    progress: 86,
  },
  {
    stage: "ARRIVED",
    label: "Delivered at Your Doorstep!",
    subtitle: "Enjoy your meal!",
    eta: 0,
    progress: 100,
  },
];

export function CrystalLiveTrackingModal({
  order,
  theme,
  isDark,
  onClose,
  onAdvanceStage,
}: CrystalLiveTrackingModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Keyed on the order's identity, not the object: a stage update must not close and
  // reopen the dialog.
  const openOrderId = order?.orderId;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (openOrderId && dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, [openOrderId]);
  if (!order) return null;

  const currentStageIndex = STAGE_SEQUENCE.findIndex(
    (s) => s.stage === order.stage
  );
  const currentMeta = STAGE_SEQUENCE[currentStageIndex] || STAGE_SEQUENCE[0];

  return (
    <dialog
      ref={dialogRef}
      aria-label="Demo order tracking"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}
      data-testid="crystal-tracking-modal"
      className="fixed inset-0 z-50 m-0 border-0 w-screen h-dvh max-w-none max-h-none flex items-center justify-center bg-black/80 backdrop-blur-md p-4 overflow-y-auto"
    >
      <div
        className={`w-full max-w-3xl rounded-3xl border shadow-2xl overflow-hidden my-auto ${
          isDark
            ? "bg-[#0E131D] border-white/15 text-white"
            : "bg-white border-slate-200 text-slate-900"
        }`}
      >
        {/* Header */}
        <div
          className="p-5 text-white flex items-center justify-between"
          style={{ backgroundColor: theme.primaryHex }}
        >
          <div>
            <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider opacity-90">
              <span className="break-all">DEMO TRACKING • {order.orderId}</span>
            </div>
            <h2 className="text-xl font-black mt-0.5">{currentMeta.label}</h2>
            <p className="text-xs opacity-90">Simulated delivery status. No real rider or GPS connection.</p>
          </div>

          <div className="flex items-center gap-3">
            <div className="px-3.5 py-2 rounded-2xl bg-black/30 backdrop-blur-md text-center">
              <div className="text-lg font-black flex items-center gap-1">
                <Clock className="w-4 h-4" />
                <span>
                  {currentMeta.eta === 0 ? "Arrived" : `${currentMeta.eta} min`}
                </span>
              </div>
              <div className="text-[10px] uppercase tracking-wider opacity-80">
                Demo ETA
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label="Close tracking"
              data-testid="close-crystal-modal"
              className="p-2 rounded-full bg-black/25 hover:bg-black/40 transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Interactive Crystal Map Canvas */}
        <div className="relative h-56 bg-[#090D16] overflow-hidden border-b border-white/10">
          {/* Stylized Map Grid & Polyline Route */}
          <svg
            viewBox="0 0 800 220"
            className="w-full h-full object-cover opacity-90"
          >
            <defs>
              <pattern
                id="crystalGrid"
                width="40"
                height="40"
                patternUnits="userSpaceOnUse"
              >
                <path
                  d="M 40 0 L 0 0 0 40"
                  fill="none"
                  stroke="rgba(255,255,255,0.05)"
                  strokeWidth="1"
                />
              </pattern>
            </defs>
            <rect width="800" height="220" fill="url(#crystalGrid)" />

            {/* Roads */}
            <path
              d="M 80 165 Q 280 55, 440 120 T 710 75"
              fill="none"
              stroke="rgba(255,255,255,0.16)"
              strokeWidth="10"
              strokeLinecap="round"
            />
            {/* Active Polyline (libzomato_crystal.so decodePolyline) */}
            <path
              d="M 80 165 Q 280 55, 440 120 T 710 75"
              fill="none"
              stroke={theme.primaryHex}
              strokeWidth="4"
              strokeDasharray="8 6"
            />

            {/* Restaurant Origin Pin */}
            <circle cx="80" cy="165" r="12" fill="#F59E0B" />
            <circle cx="80" cy="165" r="5" fill="#090D16" />

            {/* Customer Destination Pin */}
            <circle cx="710" cy="75" r="12" fill={theme.primaryHex} />
            <circle cx="710" cy="75" r="5" fill="#090D16" />
          </svg>

          {/* Animated Delivery Valet Marker */}
          <div
            className="absolute top-1/2 -translate-y-1/2 transition-all duration-700"
            style={{
              left: `calc(${Math.min(88, Math.max(10, currentMeta.progress))}% - 24px)`,
            }}
          >
            <div
              className="px-3 py-1.5 rounded-2xl text-white text-xs font-black shadow-2xl flex items-center gap-1.5 border border-white/30"
              style={{ backgroundColor: theme.primaryHex }}
            >
              <Bike className="w-4 h-4" />
              <span>{order.rider.name}</span>
            </div>
          </div>

          {/* Origin & Destination Labels */}
          <div className="absolute bottom-3 left-4 px-3 py-1 rounded-xl bg-black/75 border border-white/15 text-[11px] text-white flex items-center gap-1.5">
            <Store className="w-3.5 h-3.5 text-amber-400" />
            <span>{order.restaurantName}</span>
          </div>
          <div className="absolute top-3 right-4 px-3 py-1 rounded-xl bg-black/75 border border-white/15 text-[11px] text-white flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5 text-emerald-400" />
            <span>{order.customerAddress.displayTitle}</span>
          </div>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5">
          {/* 5-Stage Crystal Stepper */}
          <div className="grid grid-cols-5 gap-2">
            {STAGE_SEQUENCE.map((step, idx) => {
              const completed = idx <= currentStageIndex;
              return (
                <div
                  key={step.stage}
                  className={`p-2.5 rounded-2xl border text-center transition ${
                    completed
                      ? "border-emerald-500/40 bg-emerald-500/10"
                      : isDark
                      ? "border-white/5 bg-white/[0.02] opacity-45"
                      : "border-slate-200 bg-slate-50 opacity-50"
                  }`}
                >
                  <div className="flex justify-center mb-1">
                    <CheckCircle2
                      className="w-4 h-4"
                      style={{
                        color: completed ? theme.primaryHex : "currentColor",
                      }}
                    />
                  </div>
                  <div className="text-[11px] font-extrabold leading-tight">
                    {step.label.split(" ")[0]} {step.label.split(" ")[1]}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Rider Profile + Order Summary */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div
              className={`p-4 rounded-2xl border flex items-center justify-between ${
                isDark ? "bg-[#141A26] border-white/10" : "bg-slate-50 border-slate-200"
              }`}
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-black text-sm">{order.rider.name}</span>
                  <span className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold">
                    ★ {order.rider.rating}
                  </span>
                </div>
                <div className="text-xs opacity-65">
                  EV Bike #{order.rider.vehicleNumber} • {order.rider.deliveriesCount}+ deliveries
                </div>
                <div className="text-[11px] text-emerald-400 flex items-center gap-1 font-medium">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Demo partner profile
                </div>
              </div>

              <button
                type="button"
                disabled
                className="p-3 rounded-2xl text-white shadow"
                style={{ backgroundColor: theme.primaryHex }}
                title="Calling is unavailable for demo orders"
                aria-label="Calling unavailable in demo"
              >
                <PhoneCall className="w-4 h-4" />
              </button>
            </div>

            <div
              className={`p-4 rounded-2xl border flex items-center justify-between ${
                isDark ? "bg-[#141A26] border-white/10" : "bg-slate-50 border-slate-200"
              }`}
            >
              <div className="space-y-1 text-xs">
                <div className="font-black text-sm">
                  {order.items.reduce((s, i) => s + i.quantity, 0)} Items • ₹
                  {order.quote.grandTotal}
                </div>
                <div className="opacity-65 truncate max-w-[210px]">
                  {order.items.map((i) => `${i.quantity}x ${i.item.name}`).join(", ")}
                </div>
                <div className="text-[11px] opacity-60 font-mono">
                  Paid via {order.paymentMethod.split("•")[0]}
                </div>
              </div>

              {order.stage !== "ARRIVED" && (
                <button
                  type="button"
                  onClick={onAdvanceStage}
                  data-testid="simulate-next-crystal-stage"
                  className="px-3.5 py-2.5 rounded-xl text-xs font-black text-white flex items-center gap-1.5 shadow"
                  style={{ backgroundColor: theme.primaryHex }}
                >
                  <FastForward className="w-3.5 h-3.5" />
                  <span>Simulate Next Step</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </dialog>
  );
}
