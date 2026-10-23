import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDemoOrder,
  createValidatedReservation,
  deliverySlotProblem,
  DEMO_PAYMENT_METHODS,
  restoreReservationHistory,
  scheduledDueAt,
  validateCheckout,
  validateReservationRequest,
} from "@/lib/checkout";
import {
  atOutletClock,
  BOOKING_WINDOW_DAYS,
  bookingDateOptions,
  bookingTimeProblem,
  formatBookingDate,
  outletDateKey,
  parseSlotTime,
} from "@/lib/outletClock";
import { RESTAURANTS_DATA } from "@/data/zomatoReconstructedData";

// Bookings and delivery slots are tested on the legacy fictional catalog, which the app no longer ships.
vi.mock("@/data/zomatoReconstructedData", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/data/zomatoReconstructedData")>()),
  ...(await import("./support/legacyCatalog")).LEGACY_CATALOG,
}));

// Every instant is written in UTC with its IST reading alongside, so the expectations hold on
// any host. The suite also runs the host in another zone: server-local maths would fail here.
const ist = (utc: string) => new Date(utc);
const hostZone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/New_York";
});
afterAll(() => {
  if (hostZone === undefined) delete process.env.TZ;
  else process.env.TZ = hostZone;
});

describe("the outlet's clock", () => {
  it("rolls the calendar day over at midnight in India, not on the host", () => {
    expect(outletDateKey(ist("2026-10-22T18:29:00Z"))).toBe("2026-10-22"); // 23:59 IST
    expect(outletDateKey(ist("2026-10-22T18:30:00Z"))).toBe("2026-10-23"); // 00:00 IST
  });

  it("finds the instant a wall-clock time falls on", () => {
    expect(atOutletClock(ist("2026-10-22T04:30:00Z"), 20, 0).toISOString()).toBe("2026-10-22T14:30:00.000Z");
    expect(atOutletClock(ist("2026-10-31T10:00:00Z"), 12, 30, 1).toISOString()).toBe("2026-11-01T07:00:00.000Z");
  });

  it("reads the slot times the catalog publishes", () => {
    expect(parseSlotTime("12:30 PM")).toBe(750);
    expect(parseSlotTime("12:00 AM")).toBe(0);
    expect(parseSlotTime(" 07:30 pm ")).toBe(1170);
    expect(parseSlotTime("13:00 PM")).toBeNull();
    expect(parseSlotTime("7:5 PM")).toBeNull();
    for (const restaurant of RESTAURANTS_DATA) {
      for (const slot of restaurant.diningSlots) {
        expect(parseSlotTime(slot.time), `${restaurant.name} ${slot.time}`).not.toBeNull();
      }
    }
  });
});

describe("scheduled delivery windows", () => {
  const placedAt10 = ist("2026-10-22T04:30:00Z"); // 10:00 IST

  it("falls due at 8 PM in India whatever zone the server runs in", () => {
    expect(scheduledDueAt("Tonight, 8:00 PM", placedAt10).toISOString()).toBe("2026-10-22T14:30:00.000Z");
    expect(scheduledDueAt("Tomorrow, 12:30 PM", placedAt10).toISOString()).toBe("2026-10-23T07:00:00.000Z");
    expect(scheduledDueAt("In 1 hour", placedAt10).getTime()).toBe(placedAt10.getTime() + 3_600_000);
  });

  it("counts 'tomorrow' from India's date, which can be ahead of the host's", () => {
    const justAfterMidnight = ist("2026-10-22T19:00:00Z"); // 00:30 IST on the 23rd
    expect(scheduledDueAt("Tomorrow, 12:30 PM", justAfterMidnight).toISOString()).toBe(
      "2026-10-24T07:00:00.000Z"
    );
  });

  it("still gives an older late-evening order a future time when replayed", () => {
    const lateEvening = ist("2026-10-22T15:30:00Z"); // 21:00 IST
    expect(scheduledDueAt("Tonight, 8:00 PM", lateEvening).toISOString()).toBe("2026-10-23T14:30:00.000Z");
  });

  it("closes tonight's window at 8 PM and reopens it after midnight", () => {
    expect(deliverySlotProblem("Tonight, 8:00 PM", ist("2026-10-22T14:29:00Z"))).toBeNull();
    expect(deliverySlotProblem("Tonight, 8:00 PM", ist("2026-10-22T14:30:00Z"))).toMatch(/has passed/);
    expect(deliverySlotProblem("Tonight, 8:00 PM", ist("2026-10-22T19:00:00Z"))).toBeNull();
    expect(deliverySlotProblem("Tomorrow, 12:30 PM", ist("2026-10-22T17:00:00Z"))).toBeNull();
  });

  it("refuses a passed window at placement but keeps replaying orders that used one", () => {
    const tonight = {
      items: [{ itemId: "ctl_820099425", quantity: 1, optionIds: ["opt_500g"] }],
      addressId: "addr_cp_514",
      paymentMethod: DEMO_PAYMENT_METHODS[0],
      couponCode: null,
      isGoldMember: false,
      riderTip: 0,
      scheduledSlot: "Tonight, 8:00 PM",
    };
    expect(() => validateCheckout(tonight, { now: ist("2026-10-22T15:00:00Z") })).toThrow(/has passed/);
    expect(validateCheckout(tonight, { now: placedAt10 }).scheduledSlot).toBe("Tonight, 8:00 PM");
    expect(createDemoOrder(tonight).scheduledSlot).toBe("Tonight, 8:00 PM");
  });
});

describe("table booking dates", () => {
  const lateNight = ist("2026-10-28T19:00:00Z"); // 00:30 IST on Thu 29 Oct

  it("offers the booking window from India's today, across a month end", () => {
    const options = bookingDateOptions(lateNight);
    expect(options).toHaveLength(BOOKING_WINDOW_DAYS);
    expect(options[0]).toEqual({ value: "2026-10-29", label: "Today · Thu, 29 Oct" });
    expect(options[1].label).toBe("Tomorrow · Fri, 30 Oct");
    expect(options.at(-1)?.value).toBe("2026-11-04");
  });

  it("shows ISO dates for people and leaves older free-text dates alone", () => {
    expect(formatBookingDate("2026-10-22")).toBe("Thu, 22 Oct");
    expect(formatBookingDate("Today, Oct 22")).toBe("Today, Oct 22");
  });

  it("refuses past days, impossible dates, days beyond the window and slots already gone", () => {
    const noon = ist("2026-10-22T06:30:00Z"); // 12:00 IST
    expect(bookingTimeProblem("2026-10-21", "07:30 PM", noon)).toMatch(/passed/);
    expect(bookingTimeProblem("2026-02-30", "07:30 PM", noon)).toMatch(/valid reservation date/);
    expect(bookingTimeProblem("Today, Oct 22", "07:30 PM", noon)).toMatch(/valid reservation date/);
    expect(bookingTimeProblem("2026-10-29", "07:30 PM", noon)).toMatch(/next 7 days/);
    expect(bookingTimeProblem("2026-10-22", "12:00 PM", noon)).toMatch(/already passed/);
    expect(bookingTimeProblem("2026-10-22", "12:30 PM", noon)).toBeNull();
    expect(bookingTimeProblem("2026-10-23", "11:00 AM", noon)).toBeNull();
  });
});

describe("booking placement versus booking history", () => {
  const restaurant = RESTAURANTS_DATA.find((candidate) => candidate.resId === 19677790)!;
  const evening = restaurant.diningSlots.find((slot) => slot.time === "07:30 PM")!;
  const booking = (date: string) => ({
    resId: restaurant.resId,
    date,
    timeSlot: evening.time,
    guests: 2,
    guestName: "Asha Rao",
    guestPhone: "+91 98111 22233",
  });
  const noon = ist("2026-10-22T06:30:00Z");

  it("accepts a real upcoming slot and refuses free text, past days and gone slots", () => {
    expect(validateReservationRequest(booking("2026-10-22"), noon).date).toBe("2026-10-22");
    expect(() => validateReservationRequest(booking("Today, Oct 22"), noon)).toThrow(/valid reservation date/);
    expect(() => validateReservationRequest(booking("2026-10-21"), noon)).toThrow(/passed/);
    expect(() => validateReservationRequest(booking("2026-10-22"), ist("2026-10-22T15:00:00Z"))).toThrow(
      /already passed/
    );
  });

  it("keeps past and pre-ISO bookings in history", () => {
    const past = createValidatedReservation(booking("2020-01-01"));
    const legacy = createValidatedReservation(booking("Today, Oct 22"));
    expect(restoreReservationHistory(JSON.stringify([past, legacy]))).toHaveLength(2);
  });
});
