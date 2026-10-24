"use client";

import React, { useMemo } from "react";
import type { PosMenuItem } from "@/lib/pos/posEngine";

export function DietaryMark({ dietary }: { dietary: "veg" | "non-veg" | "egg" }) {
  const tone =
    dietary === "veg"
      ? "border-emerald-500 bg-emerald-500"
      : dietary === "egg"
      ? "border-amber-500 bg-amber-500"
      : "border-rose-500 bg-rose-500";
  const [border, background] = tone.split(" ");
  return (
    <span
      aria-label={dietary}
      title={dietary}
      className={`inline-flex w-3.5 h-3.5 shrink-0 items-center justify-center rounded-sm border-2 ${border}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${background}`} />
    </span>
  );
}

interface Dish {
  dishId: string;
  dishName: string;
  categoryName: string;
  dietary: PosMenuItem["dietary"];
  portions: PosMenuItem[];
}

function groupDishes(items: readonly PosMenuItem[]): Dish[] {
  const dishes = new Map<string, Dish>();
  for (const item of items) {
    const found = dishes.get(item.dishId);
    if (found) {
      found.portions.push(item);
      continue;
    }
    dishes.set(item.dishId, {
      dishId: item.dishId,
      dishName: item.dishName,
      categoryName: item.categoryName,
      dietary: item.dietary,
      portions: [item],
    });
  }
  return [...dishes.values()];
}

function CountBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-1 rounded-full bg-emerald-400 px-1.5 text-[10px] font-black leading-4 text-black">
      ×{count}
    </span>
  );
}

/**
 * One card per dish. A dish sold in portions shows them as buttons on the card, so Half or
 * Full is a single tap instead of a hunt through a list of near-identical items.
 */
export function PosMenuGrid({
  items,
  grouped,
  countOf,
  onAdd,
}: {
  items: readonly PosMenuItem[];
  /** Section headings per category; off while searching or filtered to one category. */
  grouped: boolean;
  /** How many of this item the open table already has, for at-a-glance feedback. */
  countOf: (itemId: string) => number;
  onAdd: (item: PosMenuItem) => void;
}) {
  const dishes = useMemo(() => groupDishes(items), [items]);
  const sections = useMemo(() => {
    if (!grouped) return [{ name: null, dishes }];
    const byCategory = new Map<string, Dish[]>();
    for (const dish of dishes) {
      byCategory.set(dish.categoryName, [...(byCategory.get(dish.categoryName) ?? []), dish]);
    }
    return [...byCategory].map(([name, list]) => ({ name, dishes: list }));
  }, [dishes, grouped]);

  if (dishes.length === 0) {
    return <p className="text-xs opacity-60">No dishes match this search.</p>;
  }

  return (
    <div className="space-y-4">
      {sections.map((section) => (
        <div key={section.name ?? "all"} className="space-y-2">
          {section.name && (
            <h3 className="text-[11px] font-black uppercase tracking-wider text-white/50">
              {section.name}
            </h3>
          )}
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {section.dishes.map((dish) =>
              dish.portions.length === 1 && dish.portions[0].portion === null ? (
                <SingleDish key={dish.dishId} dish={dish} count={countOf(dish.portions[0].itemId)} onAdd={onAdd} />
              ) : (
                <PortionedDish key={dish.dishId} dish={dish} countOf={countOf} onAdd={onAdd} />
              )
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function SingleDish({ dish, count, onAdd }: { dish: Dish; count: number; onAdd: (item: PosMenuItem) => void }) {
  const item = dish.portions[0];
  return (
    <button
      type="button"
      data-testid={`pos-menu-${item.itemId}`}
      aria-label={`${item.name}, ₹${item.price}`}
      onClick={() => onAdd(item)}
      className={`flex min-h-14 items-center justify-between gap-2 rounded-2xl border bg-[#121721] px-3 py-2.5 text-left transition active:scale-[0.98] ${
        count > 0 ? "border-emerald-400/70" : "border-white/10 hover:border-emerald-400/60"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <DietaryMark dietary={dish.dietary} />
        <span className="truncate text-sm font-bold">{dish.dishName}</span>
        <CountBadge count={count} />
      </span>
      <span className="shrink-0 text-sm font-black text-emerald-400">₹{item.price}</span>
    </button>
  );
}

function PortionedDish({
  dish,
  countOf,
  onAdd,
}: {
  dish: Dish;
  countOf: (itemId: string) => number;
  onAdd: (item: PosMenuItem) => void;
}) {
  return (
    // One row on a phone so more dishes fit on screen; stacked in the narrow desktop columns.
    <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-[#121721] p-2 xl:flex-col xl:items-stretch xl:p-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-2 px-0.5 xl:flex-none">
        <DietaryMark dietary={dish.dietary} />
        <span className="text-sm font-bold leading-tight">{dish.dishName}</span>
      </div>
      <div className="flex shrink-0 gap-1.5">
        {dish.portions.map((item) => {
          const count = countOf(item.itemId);
          return (
            <button
              key={item.itemId}
              type="button"
              data-testid={`pos-menu-${item.itemId}`}
              aria-label={`${item.name}, ₹${item.price}`}
              onClick={() => onAdd(item)}
              className={`flex min-h-11 w-[4.5rem] flex-col items-center justify-center rounded-xl border px-1 py-1.5 transition active:scale-95 xl:w-auto xl:flex-1 ${
                count > 0
                  ? "border-emerald-400 bg-emerald-500/15"
                  : "border-white/10 bg-[#0E131D] hover:border-emerald-400/60"
              }`}
            >
              <span className="flex items-center text-[11px] font-bold opacity-80">
                {item.portion}
                <CountBadge count={count} />
              </span>
              <span className="text-sm font-black text-emerald-400">₹{item.price}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
