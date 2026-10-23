import {
  applyModifierToggle,
  CART_LIMITS,
  defaultModifierSelection,
  modifierSelectionProblem,
} from "./cartEngine";
import type { DishItem, ModifierGroup, ModifierOption } from "@/types/krave";

/**
 * One dish being customised. The fields open, reset and close together, and the options
 * obey the group rules on every change, so they live in one reducer rather than four
 * independent `useState`s that could disagree.
 */
export interface CustomiserState {
  dish: DishItem;
  groups: ModifierGroup[];
  options: ModifierOption[];
  quantity: number;
  note: string;
}

export type CustomiserAction =
  | { type: "OPEN"; dish: DishItem; groups: ModifierGroup[] }
  | { type: "CLOSE" }
  | { type: "TOGGLE_OPTION"; groupId: string; option: ModifierOption }
  | { type: "STEP_QUANTITY"; delta: number }
  | { type: "SET_NOTE"; note: string };

export function customiserReducer(
  state: CustomiserState | null,
  action: CustomiserAction
): CustomiserState | null {
  if (action.type === "OPEN") {
    return {
      dish: action.dish,
      groups: action.groups,
      options: defaultModifierSelection(action.groups),
      quantity: 1,
      note: "",
    };
  }
  if (action.type === "CLOSE" || state === null) return null;

  switch (action.type) {
    case "TOGGLE_OPTION": {
      const group = state.groups.find((candidate) => candidate.id === action.groupId);
      if (!group) return state;
      const options = applyModifierToggle(group, state.options, action.option);
      return options === state.options ? state : { ...state, options };
    }
    case "STEP_QUANTITY": {
      if (!Number.isFinite(action.delta)) return state;
      const quantity = Math.min(
        CART_LIMITS.maxLineQuantity,
        Math.max(1, state.quantity + Math.trunc(action.delta))
      );
      return quantity === state.quantity ? state : { ...state, quantity };
    }
    case "SET_NOTE":
      return { ...state, note: action.note.slice(0, CART_LIMITS.maxInstructionLength) };
  }
}

/** What stops this selection being added, or null when it can go in the cart. */
export function customiserProblem(state: CustomiserState): string | null {
  return modifierSelectionProblem(state.groups, new Set(state.options.map((option) => option.id)));
}
