/**
 * The outlets' wall clock. Every outlet trades in India, and Asia/Kolkata has been a fixed
 * UTC+05:30 with no daylight saving since 1945, so a constant offset is exact. It gives the
 * same answer on a UTC server, in a browser abroad and in tests, without a time-zone database.
 */
export const OUTLET_TIME_ZONE = "Asia/Kolkata";

const OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days a table can be booked for, starting today. The picker offers exactly these. */
export const BOOKING_WINDOW_DAYS = 7;

const DAY_LABEL = new Intl.DateTimeFormat("en-IN", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

function outletFields(instant: Date): Date {
  return new Date(instant.getTime() + OFFSET_MS);
}

/** The outlet's calendar day containing `instant`, as `YYYY-MM-DD`. */
export function outletDateKey(instant: Date): string {
  return outletFields(instant).toISOString().slice(0, 10);
}

/** Minutes past midnight on the outlet's clock. */
export function outletMinuteOfDay(instant: Date): number {
  const fields = outletFields(instant);
  return fields.getUTCHours() * 60 + fields.getUTCMinutes();
}

/** The instant the outlet's clock reads `hours:minutes`, `dayOffset` days after `instant`'s day. */
export function atOutletClock(instant: Date, hours: number, minutes: number, dayOffset = 0): Date {
  const fields = outletFields(instant);
  const local = Date.UTC(
    fields.getUTCFullYear(),
    fields.getUTCMonth(),
    fields.getUTCDate() + dayOffset,
    hours,
    minutes
  );
  return new Date(local - OFFSET_MS);
}

/** UTC midnight of a `YYYY-MM-DD` key, or null for malformed or impossible dates (2026-02-30). */
function dateKeyTime(key: string): number | null {
  const match = ISO_DATE.exec(key);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, day);
  const check = new Date(time);
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day
    ? time
    : null;
}

/** `"07:30 PM"` → 1170 minutes past midnight; null for anything else. */
export function parseSlotTime(slot: string): number | null {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(slot.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  return ((hour % 12) + (match[3].toUpperCase() === "PM" ? 12 : 0)) * 60 + minute;
}

export interface BookingDateOption {
  value: string;
  label: string;
}

/** The bookable days as of `now`, labelled the way a guest reads them. */
export function bookingDateOptions(now: Date): BookingDateOption[] {
  const today = dateKeyTime(outletDateKey(now)) as number;
  return Array.from({ length: BOOKING_WINDOW_DAYS }, (_, offset) => {
    const day = new Date(today + offset * DAY_MS);
    const label = DAY_LABEL.format(day);
    const prefix = offset === 0 ? "Today · " : offset === 1 ? "Tomorrow · " : "";
    return { value: day.toISOString().slice(0, 10), label: `${prefix}${label}` };
  });
}

/** A booking date for display. Bookings stored before dates were ISO keep their original text. */
export function formatBookingDate(date: string): string {
  const time = dateKeyTime(date);
  return time === null ? date : DAY_LABEL.format(new Date(time));
}

/** Why a table at `slot` on `dateKey` cannot be booked at `now`, or null when it can. */
export function bookingTimeProblem(dateKey: string, slot: string, now: Date): string | null {
  const day = dateKeyTime(dateKey);
  if (day === null) return "Please select a valid reservation date.";
  const offset = Math.round((day - (dateKeyTime(outletDateKey(now)) as number)) / DAY_MS);
  if (offset < 0) return "That date has passed. Please pick another day.";
  if (offset >= BOOKING_WINDOW_DAYS) {
    return `Tables can be booked for the next ${BOOKING_WINDOW_DAYS} days only.`;
  }
  const minute = parseSlotTime(slot);
  if (minute === null) return "Please select an available dining time slot.";
  if (offset === 0 && minute <= outletMinuteOfDay(now)) {
    return `${slot} has already passed today. Please pick a later time.`;
  }
  return null;
}
