import { describe, expect, it } from "vitest";
import {
  customerCanCancel,
  formatPaise,
  isValidClockTime,
  isWithinOpeningHours,
  orderTotals,
  OWNER_ORDER_TRANSITIONS,
  unitPricePaise,
  type OpeningHours,
} from "@/lib/managedOrders";

const biriyani = {
  pricePaise: 10_000,
  discountedPricePaise: null,
  variants: [
    { id: "half", priceDeltaPaise: 0 },
    { id: "full", priceDeltaPaise: 10_000 },
  ],
  addons: [
    { id: "egg", pricePaise: 1_500 },
    { id: "raita", pricePaise: 2_000 },
  ],
};

describe("unitPricePaise", () => {
  it("adds the portion difference and each add-on", () => {
    expect(unitPricePaise(biriyani, "full", ["egg", "raita"])).toBe(23_500);
  });

  it("starts from the discounted price when one is set, as the server does", () => {
    expect(unitPricePaise({ ...biriyani, discountedPricePaise: 9_000 }, "full", [])).toBe(19_000);
  });

  it("requires a portion when the dish has portions", () => {
    expect(unitPricePaise(biriyani, null, [])).toBeNull();
  });

  it("refuses a portion that belongs to another dish or no longer exists", () => {
    expect(unitPricePaise(biriyani, "family", [])).toBeNull();
    expect(unitPricePaise({ ...biriyani, variants: [] }, "half", [])).toBeNull();
  });

  it("refuses an unknown or repeated add-on rather than charging it twice", () => {
    expect(unitPricePaise(biriyani, "half", ["cheese"])).toBeNull();
    expect(unitPricePaise(biriyani, "half", ["egg", "egg"])).toBeNull();
  });
});

describe("orderTotals", () => {
  const charges = { deliveryFeePaise: 3_000, taxEnabled: true, taxRateBps: 500 };

  it("charges the delivery fee only for delivery and never taxes it", () => {
    expect(orderTotals(20_000, { ...charges, fulfilment: "delivery" })).toEqual({
      subtotalPaise: 20_000,
      deliveryFeePaise: 3_000,
      taxPaise: 1_000,
      totalPaise: 24_000,
    });
    expect(orderTotals(20_000, { ...charges, fulfilment: "takeaway" }).deliveryFeePaise).toBe(0);
  });

  it("rounds tax half up to a whole paisa", () => {
    // 5% of ₹1.01 is 5.05 paise, which rounds to 5; 2.5% of ₹1.02 is 2.55, which rounds to 3.
    expect(orderTotals(101, { ...charges, fulfilment: "dine_in" }).taxPaise).toBe(5);
    expect(orderTotals(102, { ...charges, taxRateBps: 250, fulfilment: "dine_in" }).taxPaise).toBe(3);
  });

  it("adds no tax when tax is switched off, whatever the rate", () => {
    expect(orderTotals(10_000, { ...charges, taxEnabled: false, fulfilment: "dine_in" }).totalPaise).toBe(10_000);
  });
});

describe("opening hours", () => {
  // 2025-06-02 is a Monday. 06:30 UTC is 12:00 in India.
  const mondayNoonIst = new Date("2025-06-02T06:30:00Z");

  it("is open when no hours are set, leaving the decision to the owner's switch", () => {
    expect(isWithinOpeningHours([], mondayNoonIst, "Asia/Kolkata")).toBe(true);
  });

  it("reads the clock in the restaurant's zone, not the server's", () => {
    const hours: OpeningHours[] = [{ weekday: 1, opensAt: "11:00", closesAt: "15:00", isClosed: false }];
    expect(isWithinOpeningHours(hours, mondayNoonIst, "Asia/Kolkata")).toBe(true);
    // The same instant is 06:30 in London.
    expect(isWithinOpeningHours(hours, mondayNoonIst, "Europe/London")).toBe(false);
  });

  it("opens at the opening minute and closes at the closing minute", () => {
    const hours: OpeningHours[] = [{ weekday: 1, opensAt: "12:00", closesAt: "12:30", isClosed: false }];
    expect(isWithinOpeningHours(hours, mondayNoonIst, "Asia/Kolkata")).toBe(true);
    expect(isWithinOpeningHours(hours, new Date("2025-06-02T07:00:00Z"), "Asia/Kolkata")).toBe(false);
    expect(isWithinOpeningHours(hours, new Date("2025-06-02T06:29:00Z"), "Asia/Kolkata")).toBe(false);
  });

  it("keeps a late-night window open past midnight into the next day", () => {
    const hours: OpeningHours[] = [
      { weekday: 1, opensAt: "18:00", closesAt: "01:00", isClosed: false },
      { weekday: 2, opensAt: null, closesAt: null, isClosed: true },
    ];
    // Tuesday 00:30 IST is Monday 19:00 UTC.
    expect(isWithinOpeningHours(hours, new Date("2025-06-02T19:00:00Z"), "Asia/Kolkata")).toBe(true);
    // Tuesday 01:30 IST.
    expect(isWithinOpeningHours(hours, new Date("2025-06-02T20:00:00Z"), "Asia/Kolkata")).toBe(false);
  });

  it("treats a day the owner marked closed, or left out, as closed", () => {
    const hours: OpeningHours[] = [{ weekday: 1, opensAt: null, closesAt: null, isClosed: true }];
    expect(isWithinOpeningHours(hours, mondayNoonIst, "Asia/Kolkata")).toBe(false);
    const sundayOnly: OpeningHours[] = [{ weekday: 0, opensAt: "00:00", closesAt: "00:00", isClosed: false }];
    expect(isWithinOpeningHours(sundayOnly, mondayNoonIst, "Asia/Kolkata")).toBe(false);
  });

  it("treats 00:00 to 00:00 as open all day", () => {
    const hours: OpeningHours[] = [{ weekday: 1, opensAt: "00:00", closesAt: "00:00", isClosed: false }];
    expect(isWithinOpeningHours(hours, mondayNoonIst, "Asia/Kolkata")).toBe(true);
  });

  it("accepts only 24-hour HH:MM times", () => {
    expect(isValidClockTime("09:05")).toBe(true);
    expect(isValidClockTime("23:59")).toBe(true);
    for (const value of ["24:00", "9:05", "09:60", "", " 09:05", null]) {
      expect(isValidClockTime(value)).toBe(false);
    }
  });
});

describe("order lifecycle", () => {
  it("lets the customer cancel only before the restaurant accepts", () => {
    expect(customerCanCancel("placed")).toBe(true);
    expect(customerCanCancel("accepted")).toBe(false);
  });

  it("has no way out of a finished order", () => {
    for (const status of ["completed", "rejected", "cancelled"] as const) {
      expect(OWNER_ORDER_TRANSITIONS[status]).toEqual([]);
    }
    expect(OWNER_ORDER_TRANSITIONS.placed).not.toContain("completed");
  });

  it("formats paise as rupees without float drift", () => {
    expect(formatPaise(12_000)).toBe("₹120");
    expect(formatPaise(12_050)).toBe("₹120.50");
  });
});
