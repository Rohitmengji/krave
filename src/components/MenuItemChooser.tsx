"use client";

import { useState } from "react";
import { OverlayDialog } from "@/components/OverlayDialog";
import type { CartLine, OrderableItem } from "@/lib/managedCart";
import { formatPaise, MAX_ADDONS_PER_LINE, MAX_LINE_QUANTITY, unitPricePaise } from "@/lib/managedOrders";

type MenuItemChooserProps = {
  item: OrderableItem | null;
  onClose: () => void;
  onAdd: (line: CartLine) => void;
};

/** Portion, add-ons and quantity for one dish. Keyed by item, so each opening starts fresh. */
export function MenuItemChooser({ item, onClose, onAdd }: MenuItemChooserProps) {
  return (
    <OverlayDialog isOpen={item !== null} onClose={onClose} label={item ? `Add ${item.name}` : "Add dish"}>
      {item ? <ChooserForm key={item.id} item={item} onClose={onClose} onAdd={onAdd} /> : null}
    </OverlayDialog>
  );
}

function ChooserForm({ item, onClose, onAdd }: { item: OrderableItem; onClose: () => void; onAdd: (line: CartLine) => void }) {
  const [variantId, setVariantId] = useState<string | null>(item.variants[0]?.id ?? null);
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [quantity, setQuantity] = useState(1);
  const unit = unitPricePaise(item, variantId, addonIds);

  function toggleAddon(id: string) {
    setAddonIds((current) =>
      current.includes(id)
        ? current.filter((existing) => existing !== id)
        : current.length >= MAX_ADDONS_PER_LINE
          ? current
          : [...current, id]
    );
  }

  return (
    <form
      className="space-y-5 rounded-2xl bg-white p-6 text-[#1d2922] shadow-xl"
      onSubmit={(event) => {
        event.preventDefault();
        if (unit === null) return;
        onAdd({ itemId: item.id, variantId, addonIds, quantity });
      }}
    >
      <h2 className="text-xl font-extrabold">{item.name}</h2>
      {item.variants.length ? (
        <fieldset>
          <legend className="font-bold">Portion</legend>
          <div className="mt-2 space-y-2">
            {item.variants.map((variant) => (
              <label key={variant.id} className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-[#d9ded7] px-4 py-2 has-checked:border-emerald-800 has-checked:bg-emerald-50">
                <span className="flex items-center gap-3">
                  <input
                    type="radio"
                    name="variant"
                    value={variant.id}
                    checked={variantId === variant.id}
                    onChange={() => setVariantId(variant.id)}
                    className="size-4 accent-emerald-800"
                  />
                  {variant.name}
                </span>
                <span className="font-semibold">{formatPaise(unitPricePaise(item, variant.id, []) ?? 0)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {item.addons.length ? (
        <fieldset>
          <legend className="font-bold">Add-ons</legend>
          <div className="mt-2 space-y-2">
            {item.addons.map((addon) => (
              <label key={addon.id} className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-[#d9ded7] px-4 py-2 has-checked:border-emerald-800 has-checked:bg-emerald-50">
                <span className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={addonIds.includes(addon.id)}
                    onChange={() => toggleAddon(addon.id)}
                    className="size-4 accent-emerald-800"
                  />
                  {addon.name}
                </span>
                <span>+{formatPaise(addon.pricePaise)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <span id={`qty-${item.id}`} className="font-bold">Quantity</span>
        <div role="group" aria-labelledby={`qty-${item.id}`} className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Decrease quantity"
            disabled={quantity <= 1}
            onClick={() => setQuantity((value) => Math.max(1, value - 1))}
            className="size-11 rounded-full border border-[#d9ded7] text-xl font-bold disabled:opacity-40"
          >
            −
          </button>
          <output aria-live="polite" className="w-8 text-center text-lg font-bold">{quantity}</output>
          <button
            type="button"
            aria-label="Increase quantity"
            disabled={quantity >= MAX_LINE_QUANTITY}
            onClick={() => setQuantity((value) => Math.min(MAX_LINE_QUANTITY, value + 1))}
            className="size-11 rounded-full border border-[#d9ded7] text-xl font-bold disabled:opacity-40"
          >
            +
          </button>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-3">
        <button type="button" onClick={onClose} className="min-h-11 rounded-xl px-5 font-bold text-slate-700 hover:bg-slate-100">
          Cancel
        </button>
        <button
          type="submit"
          disabled={unit === null}
          className="min-h-11 rounded-xl bg-emerald-800 px-5 font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          Add {unit === null ? "" : formatPaise(unit * quantity)}
        </button>
      </div>
    </form>
  );
}
