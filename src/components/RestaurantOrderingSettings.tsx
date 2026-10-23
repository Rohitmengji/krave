"use client";

import { useRef, useState } from "react";
import type { ManagedRestaurant } from "@/lib/server/restaurantStore";
import { isValidClockTime, WEEKDAY_NAMES, type OpeningHours } from "@/lib/managedOrders";

type SaveState = { status: "idle" } | { status: "saving" } | { status: "saved"; message: string } | { status: "error"; message: string };

type DayDraft = { weekday: number; isClosed: boolean; opensAt: string; closesAt: string };

function draftFrom(hours: OpeningHours[]): DayDraft[] {
  return WEEKDAY_NAMES.map((_, weekday) => {
    const day = hours.find((entry) => entry.weekday === weekday);
    return {
      weekday,
      isClosed: day?.isClosed ?? false,
      opensAt: day?.opensAt ?? "11:00",
      closesAt: day?.closesAt ?? "22:30",
    };
  });
}

/**
 * The switch that lets customers order from the public menu, and the weekly hours that
 * limit it. Remount with a new key after the restaurant reloads to start from saved values.
 */
export function RestaurantOrderingSettings({
  restaurant,
  hours,
  onSaved,
}: {
  restaurant: ManagedRestaurant;
  hours: OpeningHours[];
  /** Reloads the restaurant and shows `message` in the dashboard's notice. */
  onSaved: (message: string) => Promise<unknown>;
}) {
  const [useHours, setUseHours] = useState(hours.length > 0);
  const [days, setDays] = useState(() => draftFrom(hours));
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const inFlight = useRef(false);
  const saving = save.status === "saving";
  const modes = [
    restaurant.dineInEnabled ? "dine-in" : null,
    restaurant.takeawayEnabled ? "takeaway" : null,
    restaurant.deliveryEnabled && restaurant.serviceAreas.length ? "delivery" : null,
  ].filter(Boolean);
  const warnings = [
    restaurant.status !== "published" ? "The restaurant is not published, so customers cannot see the menu yet." : null,
    modes.length === 0 ? "Turn on dine-in, takeaway or delivery in the restaurant details." : null,
    restaurant.deliveryEnabled && restaurant.serviceAreas.length === 0
      ? "Delivery is on but no delivery areas are listed, so delivery is not offered."
      : null,
    !restaurant.phone ? "Add a phone number so customers can reach you about their order." : null,
  ].filter((warning): warning is string => warning !== null);

  async function patch(body: Record<string, unknown>, message: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSave({ status: "saving" });
    try {
      const response = await fetch(`/api/owner/${encodeURIComponent(restaurant.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const reply = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) throw new Error(reply.message ?? "The settings could not be saved.");
      setSave({ status: "saved", message });
      await onSaved(message);
    } catch (error) {
      setSave({
        status: "error",
        message: error instanceof TypeError ? "You seem to be offline. Nothing was changed." : (error as Error).message,
      });
    } finally {
      inFlight.current = false;
    }
  }

  function saveHours() {
    if (!useHours) {
      void patch({ hours: [] }, "Opening hours removed. Orders are taken whenever online ordering is on.");
      return;
    }
    const invalid = days.find((day) => !day.isClosed && (!isValidClockTime(day.opensAt) || !isValidClockTime(day.closesAt)));
    if (invalid) {
      setSave({ status: "error", message: `Enter opening and closing times for ${WEEKDAY_NAMES[invalid.weekday]}.` });
      return;
    }
    void patch(
      {
        hours: days.map((day) =>
          day.isClosed
            ? { weekday: day.weekday, isClosed: true, opensAt: null, closesAt: null }
            : { weekday: day.weekday, isClosed: false, opensAt: day.opensAt, closesAt: day.closesAt }
        ),
      },
      "Opening hours saved."
    );
  }

  return (
    <section aria-labelledby="ordering-heading" className="space-y-5 rounded-2xl border border-white/10 bg-[#121721] p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="ordering-heading" className="text-xl font-bold">Online ordering</h2>
          <p className="mt-1 text-sm text-slate-400">
            {restaurant.acceptingOrders
              ? `On: customers can place ${modes.join(", ") || "no"} orders from your menu page.`
              : "Off: your menu is shown, and customers are asked to call."}{" "}
            No payment is taken online.
          </p>
        </div>
        <button
          type="button"
          disabled={saving}
          aria-pressed={restaurant.acceptingOrders}
          onClick={() =>
            void patch(
              { acceptingOrders: !restaurant.acceptingOrders },
              restaurant.acceptingOrders ? "Online ordering paused." : "Online ordering is on."
            )
          }
          className={`min-h-11 rounded-xl px-5 font-bold disabled:opacity-50 ${
            restaurant.acceptingOrders ? "border border-amber-300/50 text-amber-100" : "bg-emerald-600 text-white"
          }`}
        >
          {restaurant.acceptingOrders ? "Pause online orders" : "Start taking orders"}
        </button>
      </div>

      {warnings.length ? (
        <ul className="list-disc space-y-1 pl-5 text-sm text-amber-200">
          {warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}

      <fieldset disabled={saving} className="space-y-3">
        <legend className="font-semibold">Opening hours ({restaurant.timeZone})</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={useHours} onChange={(event) => setUseHours(event.target.checked)} />
          Only take orders during these hours
        </label>
        {useHours ? (
          <div className="grid gap-2">
            {days.map((day) => (
              <div key={day.weekday} className="flex flex-wrap items-center gap-3 text-sm">
                <span className="w-24 font-semibold">{WEEKDAY_NAMES[day.weekday]}</span>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={day.isClosed}
                    onChange={(event) =>
                      setDays((current) => current.map((entry) => (entry.weekday === day.weekday ? { ...entry, isClosed: event.target.checked } : entry)))
                    }
                  />
                  Closed
                </label>
                {!day.isClosed ? (
                  <>
                    <label className="flex items-center gap-2">
                      <span className="sr-only">{WEEKDAY_NAMES[day.weekday]}</span> Opens
                      <input
                        type="time"
                        value={day.opensAt}
                        onChange={(event) =>
                          setDays((current) => current.map((entry) => (entry.weekday === day.weekday ? { ...entry, opensAt: event.target.value } : entry)))
                        }
                        className="rounded-lg border border-white/15 bg-[#0a0d12] px-2 py-1"
                      />
                    </label>
                    <label className="flex items-center gap-2">
                      <span className="sr-only">{WEEKDAY_NAMES[day.weekday]}</span> Closes
                      <input
                        type="time"
                        value={day.closesAt}
                        onChange={(event) =>
                          setDays((current) => current.map((entry) => (entry.weekday === day.weekday ? { ...entry, closesAt: event.target.value } : entry)))
                        }
                        className="rounded-lg border border-white/15 bg-[#0a0d12] px-2 py-1"
                      />
                    </label>
                  </>
                ) : null}
              </div>
            ))}
            <p className="text-xs text-slate-400">A closing time earlier than the opening time runs past midnight.</p>
          </div>
        ) : (
          <p className="text-sm text-slate-400">Without hours, orders are taken whenever online ordering is on.</p>
        )}
        <button type="button" onClick={saveHours} className="rounded-xl border border-white/20 px-4 py-2 font-bold disabled:opacity-50">
          {saving ? "Saving…" : "Save hours"}
        </button>
      </fieldset>

      <p role="status" aria-live="polite" className={save.status === "error" ? "text-sm text-red-200" : "text-sm text-emerald-300"}>
        {save.status === "saved" || save.status === "error" ? save.message : ""}
      </p>
    </section>
  );
}
