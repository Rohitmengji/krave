import { describe, expect, it } from "vitest";
import {
  RESTAURANT_ASSET_LIMIT_BYTES,
  validateRestaurantFile,
} from "@/lib/server/restaurantStorage";
import { getPublishedRestaurantBySlug } from "@/lib/server/restaurantStore";

describe("restaurant asset validation", () => {
  it("accepts supported file signatures for their allowed use", () => {
    validateRestaurantFile(
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      "application/pdf",
      "menu_document"
    );
    validateRestaurantFile(
      new Uint8Array([0xff, 0xd8, 0xff]),
      "image/jpeg",
      "menu_item_image"
    );
    validateRestaurantFile(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      "image/png",
      "menu_document"
    );
    validateRestaurantFile(
      new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      "image/webp",
      "menu_item_image"
    );
  });

  it("rejects MIME spoofing, PDFs as dish images, and empty files", () => {
    expect(() =>
      validateRestaurantFile(new Uint8Array([0xff, 0xd8, 0xff]), "image/png", "menu_document")
    ).toThrow(/real PDF, JPEG, PNG, or WebP/i);
    expect(() =>
      validateRestaurantFile(
        new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
        "application/pdf",
        "menu_item_image"
      )
    ).toThrow(/real JPEG, PNG, or WebP/i);
    expect(() => validateRestaurantFile(new Uint8Array(), "image/png", "menu_document")).toThrow(
      /smaller than 4 MB/i
    );
  });

  it("accepts the configured maximum size and rejects larger uploads", () => {
    const atLimit = new Uint8Array(RESTAURANT_ASSET_LIMIT_BYTES);
    atLimit.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(() => validateRestaurantFile(atLimit, "application/pdf", "menu_document")).not.toThrow();

    const overLimit = new Uint8Array(RESTAURANT_ASSET_LIMIT_BYTES + 1);
    overLimit.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(() => validateRestaurantFile(overLimit, "application/pdf", "menu_document")).toThrow(
      /smaller than 4 MB/i
    );
  });
});

describe("published restaurant lookup", () => {
  it("rejects invalid slugs without querying the database", async () => {
    await expect(getPublishedRestaurantBySlug("../private")).resolves.toBeNull();
    await expect(getPublishedRestaurantBySlug("A")).resolves.toBeNull();
  });
});
