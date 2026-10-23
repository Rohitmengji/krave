import { COLLECTIONS_DATA } from "@/data/zomatoReconstructedData";
import type { RestaurantFilterCriteria } from "@/lib/cartEngine";
import type { DiscoveryTabKey } from "@/types/krave";

export type RestaurantSort = NonNullable<RestaurantFilterCriteria["sortBy"]>;

export type FilterToggle = "pureVegOnly" | "minRating43" | "fastDeliveryOnly" | "walkinOfferOnly";

export interface DiscoveryFilters {
  mode: DiscoveryTabKey;
  query: string;
  collectionId: number | null;
  pureVegOnly: boolean;
  minRating43: boolean;
  fastDeliveryOnly: boolean;
  walkinOfferOnly: boolean;
  cuisine: string | null;
  sortBy: RestaurantSort;
}

export const INITIAL_FILTERS: DiscoveryFilters = {
  mode: "delivery",
  query: "",
  collectionId: null,
  pureVegOnly: false,
  minRating43: false,
  fastDeliveryOnly: false,
  walkinOfferOnly: false,
  cuisine: null,
  sortBy: "relevance",
};

export type FilterAction =
  | { type: "SET_MODE"; mode: DiscoveryTabKey }
  | { type: "SHOW_FAST_DELIVERY" }
  | { type: "SET_QUERY"; query: string }
  | { type: "TOGGLE"; filter: FilterToggle }
  | { type: "TOGGLE_COLLECTION"; collectionId: number }
  | { type: "CLEAR_COLLECTION" }
  | { type: "TOGGLE_CUISINE"; cuisine: string }
  | { type: "SET_SORT"; sortBy: RestaurantSort }
  | { type: "RESET" };

function collectionShownIn(collectionId: number | null, mode: DiscoveryTabKey): boolean {
  if (collectionId === null) return true;
  return COLLECTIONS_DATA.some(
    (collection) => collection.id === collectionId && collection.modes.includes(mode)
  );
}

/**
 * Every path that changes the mode goes through here, so a collection the new mode does not
 * list cannot stay applied while its card (and so its "clear" control) is hidden.
 */
function withMode(state: DiscoveryFilters, mode: DiscoveryTabKey): DiscoveryFilters {
  if (state.mode === mode) return state;
  return {
    ...state,
    mode,
    collectionId: collectionShownIn(state.collectionId, mode) ? state.collectionId : null,
  };
}

export function filtersReducer(state: DiscoveryFilters, action: FilterAction): DiscoveryFilters {
  switch (action.type) {
    case "SET_MODE":
      return withMode(state, action.mode);
    case "SHOW_FAST_DELIVERY": {
      // From another mode the shortcut means "show me fast delivery", not "flip the filter".
      const next = withMode(state, "delivery");
      return {
        ...next,
        fastDeliveryOnly: state.mode === "delivery" ? !state.fastDeliveryOnly : true,
      };
    }
    case "SET_QUERY":
      return state.query === action.query ? state : { ...state, query: action.query };
    case "TOGGLE":
      return { ...state, [action.filter]: !state[action.filter] };
    case "TOGGLE_COLLECTION":
      if (state.collectionId === action.collectionId) return { ...state, collectionId: null };
      return collectionShownIn(action.collectionId, state.mode)
        ? { ...state, collectionId: action.collectionId }
        : state;
    case "CLEAR_COLLECTION":
      return state.collectionId === null ? state : { ...state, collectionId: null };
    case "TOGGLE_CUISINE":
      return { ...state, cuisine: state.cuisine === action.cuisine ? null : action.cuisine };
    case "SET_SORT":
      return state.sortBy === action.sortBy ? state : { ...state, sortBy: action.sortBy };
    case "RESET":
      // The mode and sort order are where the user is, not filters they applied.
      return { ...INITIAL_FILTERS, mode: state.mode, sortBy: state.sortBy };
  }
}

export function toFilterCriteria(filters: DiscoveryFilters): RestaurantFilterCriteria {
  return {
    mode: filters.mode,
    query: filters.query,
    collectionId: filters.collectionId,
    pureVegOnly: filters.pureVegOnly,
    minRating: filters.minRating43 ? 4.3 : undefined,
    fastDeliveryOnly: filters.fastDeliveryOnly,
    hasWalkinOfferOnly: filters.walkinOfferOnly,
    cuisineFilter: filters.cuisine,
    sortBy: filters.sortBy,
  };
}
