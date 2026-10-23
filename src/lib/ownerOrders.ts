/**
 * State for the owner's order queue. Pure, so the merge and stale-response rules are tested
 * without React. Orders are typed structurally to keep server modules out of the client.
 */
import { ORDER_STATUS_LABELS, type OrderFulfilment, type RestaurantOrderStatus } from "./managedOrders";

export type OwnerOrderView = "active" | "done" | "all";

export interface OwnerOrder {
  id: string;
  orderNumber: number;
  customerName: string;
  customerPhone: string;
  fulfilment: OrderFulfilment;
  deliveryAddress: string | null;
  serviceArea: string | null;
  note: string;
  subtotalPaise: number;
  deliveryFeePaise: number;
  taxPaise: number;
  totalPaise: number;
  paymentMethod: "pay_at_restaurant" | "pay_on_delivery";
  status: RestaurantOrderStatus;
  statusReason: string | null;
  placedAt: string;
  updatedAt: string;
  lines: {
    lineNo: number;
    itemName: string;
    variantName: string | null;
    addons: { name: string }[];
    quantity: number;
    lineTotalPaise: number;
  }[];
}

export interface OwnerOrdersState {
  view: OwnerOrderView;
  /** Increments on every view change; responses for an older request are dropped. */
  request: number;
  load: "loading" | "ready" | "error";
  error: string | null;
  orders: OwnerOrder[];
  nextCursor: string | null;
  loadingMore: boolean;
  /** Order ids being changed, so their buttons stay disabled until the server answers. */
  pending: string[];
  /** Text for the live region: new arrivals and the result of the owner's last change. */
  announcement: string;
}

export type OwnerOrdersAction =
  | { type: "view"; view: OwnerOrderView }
  | { type: "reload" }
  | { type: "loaded"; request: number; orders: OwnerOrder[]; nextCursor: string | null; poll: boolean }
  | { type: "loadFailed"; request: number; message: string; poll: boolean }
  | { type: "loadingMore" }
  | { type: "more"; request: number; orders: OwnerOrder[]; nextCursor: string | null }
  | { type: "moreFailed"; request: number; message: string }
  | { type: "changing"; id: string }
  | { type: "changed"; order: OwnerOrder }
  | { type: "changeFailed"; id: string; message: string };

export const initialOwnerOrders: OwnerOrdersState = {
  view: "active",
  request: 0,
  load: "loading",
  error: null,
  orders: [],
  nextCursor: null,
  loadingMore: false,
  pending: [],
  announcement: "",
};

export function belongsToView(status: RestaurantOrderStatus, view: OwnerOrderView): boolean {
  const active = status === "placed" || status === "accepted" || status === "preparing" || status === "ready";
  return view === "all" || (view === "active") === active;
}

export function ownerOrdersReducer(state: OwnerOrdersState, action: OwnerOrdersAction): OwnerOrdersState {
  switch (action.type) {
    case "view":
      if (action.view === state.view && state.load !== "error") return state;
      return { ...initialOwnerOrders, view: action.view, request: state.request + 1 };
    case "reload":
      // Keeps the list on screen while the fresh copy loads.
      return { ...state, request: state.request + 1 };
    case "loaded": {
      if (action.request !== state.request) return state;
      const known = new Set(state.orders.map((order) => order.id));
      const arrived = action.poll
        ? action.orders.filter((order) => !known.has(order.id) && order.status === "placed").map((order) => order.orderNumber)
        : [];
      // A change in flight wins over a poll that read the row before the change landed.
      const orders = action.orders.map((order) => {
        const local = state.orders.find((existing) => existing.id === order.id);
        return local && local.updatedAt > order.updatedAt ? local : order;
      });
      const announcement = arrived.length
        ? arrived.length === 1
          ? `New order #${arrived[0]}.`
          : `${arrived.length} new orders: ${arrived.map((number) => `#${number}`).join(", ")}.`
        : state.announcement;
      return { ...state, load: "ready", error: null, orders, nextCursor: action.nextCursor, announcement };
    }
    case "loadFailed":
      if (action.request !== state.request) return state;
      // A failed background refresh keeps the list on screen.
      return action.poll && state.load === "ready"
        ? { ...state, error: action.message }
        : { ...state, load: "error", error: action.message };
    case "loadingMore":
      return state.nextCursor && !state.loadingMore ? { ...state, loadingMore: true } : state;
    case "more": {
      if (action.request !== state.request) return state;
      const known = new Set(state.orders.map((order) => order.id));
      return {
        ...state,
        loadingMore: false,
        orders: [...state.orders, ...action.orders.filter((order) => !known.has(order.id))],
        nextCursor: action.nextCursor,
      };
    }
    case "moreFailed":
      return action.request !== state.request ? state : { ...state, loadingMore: false, error: action.message };
    case "changing":
      return state.pending.includes(action.id) ? state : { ...state, pending: [...state.pending, action.id], error: null };
    case "changed":
      return {
        ...state,
        announcement: `Order #${action.order.orderNumber}: ${ORDER_STATUS_LABELS[action.order.status]}.`,
        pending: state.pending.filter((id) => id !== action.order.id),
        orders: belongsToView(action.order.status, state.view)
          ? state.orders.map((order) => (order.id === action.order.id ? action.order : order))
          : state.orders.filter((order) => order.id !== action.order.id),
      };
    case "changeFailed":
      return { ...state, pending: state.pending.filter((id) => id !== action.id), error: action.message };
  }
}
