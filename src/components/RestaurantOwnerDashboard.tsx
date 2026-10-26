"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { FormEvent } from "react";
import { OverlayDialog } from "@/components/OverlayDialog";
import { RestaurantOrderingSettings } from "@/components/RestaurantOrderingSettings";
import { PosPinSettings } from "@/components/PosPinSettings";
import { RestaurantOrdersPanel } from "@/components/RestaurantOrdersPanel";
import { RestaurantTeamPanel } from "@/components/RestaurantTeamPanel";
import type { OpeningHours } from "@/lib/managedOrders";
import { announce } from "@/lib/announcer";
import type {
  ExtractedMenuItem,
  ManagedMenuCategory,
  ManagedMenuItem,
  ManagedRestaurant,
  MenuImportJob,
} from "@/lib/server/restaurantStore";

type DashboardState = {
  phase: "loading" | "ready" | "error";
  user: { id: string; email: string; displayName: string } | null;
  isAdmin: boolean;
  menuImportConfigured: boolean;
  uploadsConfigured: boolean;
  restaurants: ManagedRestaurant[];
  selectedId: string | null;
  restaurant: ManagedRestaurant | null;
  categories: ManagedMenuCategory[];
  imports: MenuImportJob[];
  hours: OpeningHours[];
  busy: boolean;
  error: string | null;
  notice: string | null;
};

/** GET /api/owner. */
type OwnerOverview = {
  user: DashboardState["user"];
  isAdmin: boolean;
  menuImportConfigured: boolean;
  uploadsConfigured: boolean;
  restaurants: ManagedRestaurant[];
};

type DashboardAction =
  | ({ type: "loaded"; selectedId: string | null } & OwnerOverview)
  | {
      type: "detail";
      restaurant: ManagedRestaurant;
      categories: ManagedMenuCategory[];
      imports: MenuImportJob[];
      hours: OpeningHours[];
    }
  | { type: "select"; id: string }
  | { type: "busy"; value: boolean }
  | { type: "error"; message: string | null }
  | { type: "notice"; message: string | null }
  | { type: "load-error"; message: string };

const initialState: DashboardState = {
  phase: "loading",
  user: null,
  isAdmin: false,
  menuImportConfigured: false,
  uploadsConfigured: false,
  restaurants: [],
  selectedId: null,
  restaurant: null,
  categories: [],
  imports: [],
  hours: [],
  busy: false,
  error: null,
  notice: null,
};

function dashboardReducer(state: DashboardState, action: DashboardAction): DashboardState {
  switch (action.type) {
    case "loaded":
      return {
        ...state,
        phase: "ready",
        user: action.user,
        isAdmin: action.isAdmin,
        menuImportConfigured: action.menuImportConfigured,
        uploadsConfigured: action.uploadsConfigured,
        restaurants: action.restaurants,
        selectedId: action.selectedId,
      };
    case "detail":
      return {
        ...state,
        phase: "ready",
        restaurant: action.restaurant,
        categories: action.categories,
        imports: action.imports,
        hours: action.hours,
        error: null,
      };
    case "select":
      return { ...state, selectedId: action.id, restaurant: null, categories: [], imports: [], hours: [] };
    case "busy":
      return { ...state, busy: action.value };
    case "error":
      return { ...state, error: action.message };
    case "notice":
      return { ...state, notice: action.message };
    case "load-error":
      return { ...state, phase: "error", error: action.message };
  }
}

type RestaurantForm = {
  name: string;
  slug: string;
  description: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  serviceAreas: string;
  deliveryEnabled: boolean;
  takeawayEnabled: boolean;
  dineInEnabled: boolean;
  minimumOrder: string;
  deliveryFee: string;
  taxRate: string;
  taxEnabled: boolean;
  fssaiNumber: string;
  gstin: string;
};

const emptyRestaurantForm: RestaurantForm = {
  name: "Jagadamba Maratha Khanawali",
  slug: "jagadamba-maratha-khanawali",
  description: "",
  phone: "",
  email: "",
  address: "Yadgir Main Road, near Kismat Talkies",
  city: "Wadi",
  state: "Karnataka",
  postalCode: "585225",
  serviceAreas: "",
  deliveryEnabled: false,
  takeawayEnabled: true,
  dineInEnabled: true,
  minimumOrder: "0",
  deliveryFee: "0",
  taxRate: "0",
  taxEnabled: false,
  fssaiNumber: "",
  gstin: "",
};

function paiseToRupees(paise: number | null): string {
  return paise === null ? "" : (paise / 100).toFixed(2).replace(/\.00$/, "");
}

function rupeesToPaise(value: string): number | null {
  const match = value.trim().match(/^(0|[1-9]\d{0,6})(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const rupees = Number(match[1]);
  const paise = Number((match[2] ?? "").padEnd(2, "0"));
  const total = rupees * 100 + paise;
  return Number.isSafeInteger(total) ? total : null;
}

function restaurantFormFrom(value: ManagedRestaurant): RestaurantForm {
  return {
    name: value.name,
    slug: value.slug,
    description: value.description,
    phone: value.phone ?? "",
    email: value.email ?? "",
    address: value.address,
    city: value.city,
    state: value.state,
    postalCode: value.postalCode,
    serviceAreas: value.serviceAreas.join(", "),
    deliveryEnabled: value.deliveryEnabled,
    takeawayEnabled: value.takeawayEnabled,
    dineInEnabled: value.dineInEnabled,
    minimumOrder: paiseToRupees(value.minimumOrderPaise),
    deliveryFee: paiseToRupees(value.deliveryFeePaise),
    taxRate: (value.taxRateBps / 100).toString(),
    taxEnabled: value.taxEnabled,
    fssaiNumber: value.fssaiNumber,
    gstin: value.gstin,
  };
}

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init });
  const payload = (await response.json().catch(() => null)) as
    | { status?: string; message?: string }
    | null;
  if (!response.ok) {
    throw new ApiError(payload?.message || `Request failed (${response.status}).`, response.status);
  }
  return payload as T;
}

function toRestaurantPayload(form: RestaurantForm) {
  const minimumOrderPaise = rupeesToPaise(form.minimumOrder);
  const deliveryFeePaise = rupeesToPaise(form.deliveryFee);
  const taxRate = Number(form.taxRate);
  if (minimumOrderPaise === null || deliveryFeePaise === null) {
    throw new Error("Enter valid rupee amounts with up to two decimal places.");
  }
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100 || !/^\d{1,3}(?:\.\d{1,2})?$/.test(form.taxRate)) {
    throw new Error("Enter a tax rate between 0 and 100 percent.");
  }
  return {
    name: form.name,
    slug: form.slug,
    description: form.description,
    phone: form.phone,
    email: form.email,
    address: form.address,
    city: form.city,
    state: form.state,
    postalCode: form.postalCode,
    serviceAreas: form.serviceAreas.split(",").map((area) => area.trim()).filter(Boolean),
    deliveryEnabled: form.deliveryEnabled,
    takeawayEnabled: form.takeawayEnabled,
    dineInEnabled: form.dineInEnabled,
    minimumOrderPaise,
    deliveryFeePaise,
    taxRateBps: Math.round(taxRate * 100),
    taxEnabled: form.taxEnabled,
    fssaiNumber: form.fssaiNumber,
    gstin: form.gstin,
  };
}

type MenuFilter = "all" | "published" | "draft" | "unavailable";

function matchesMenuFilter(item: ManagedMenuItem, filter: MenuFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "published":
      return item.published;
    case "draft":
      return !item.published;
    case "unavailable":
      return !item.available;
  }
}

function blankItem(categoryId = "") {
  return {
    id: "",
    revision: 0,
    categoryId,
    name: "",
    description: "",
    price: "",
    discountedPrice: "",
    portionSize: "",
    dietaryTags: [] as string[],
    allergens: "",
    available: true,
    published: false,
    featured: false,
    imageAssetId: "",
    variants: [] as { id?: string; name: string; price: string }[],
    addons: [] as { id?: string; name: string; price: string }[],
  };
}

function itemFormFrom(item: ManagedMenuItem) {
  return {
    id: item.id,
    revision: item.revision,
    categoryId: item.categoryId,
    name: item.name,
    description: item.description,
    price: paiseToRupees(item.pricePaise),
    discountedPrice: paiseToRupees(item.discountedPricePaise),
    portionSize: item.portionSize,
    dietaryTags: item.dietaryTags,
    allergens: item.allergens.join(", "),
    available: item.available,
    published: item.published,
    featured: item.featured,
    imageAssetId: item.imageAssetId ?? "",
    variants: item.variants.map((variant) => ({
      id: variant.id,
      name: variant.name,
      price: paiseToRupees(variant.priceDeltaPaise + item.pricePaise),
    })),
    addons: item.addons.map((addon) => ({
      id: addon.id,
      name: addon.name,
      price: paiseToRupees(addon.pricePaise),
    })),
  };
}

export function RestaurantOwnerDashboard() {
  const [state, dispatch] = useReducer(dashboardReducer, initialState);
  const [restaurantForm, setRestaurantForm] = useState(emptyRestaurantForm);
  const [categoryName, setCategoryName] = useState("");
  const [itemForm, setItemForm] = useState(blankItem());
  const [menuFiles, setMenuFiles] = useState<File[]>([]);
  const [activeImportId, setActiveImportId] = useState<string | null>(null);
  const [reviewItems, setReviewItems] = useState<ExtractedMenuItem[]>([]);
  const [selectedDraftIds, setSelectedDraftIds] = useState<string[]>([]);
  const [menuQuery, setMenuQuery] = useState("");
  const [menuFilter, setMenuFilter] = useState<MenuFilter>("all");
  const [pendingDelete, setPendingDelete] = useState<ManagedMenuItem | null>(null);
  const busyRef = useRef(false);
  const detailAbort = useRef<AbortController | null>(null);
  const dishNameRef = useRef<HTMLInputElement>(null);
  const restaurantId = state.selectedId;

  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<OwnerOverview>("/api/owner", { signal: controller.signal })
      .then((result) => {
        dispatch({
          type: "loaded",
          user: result.user,
          isAdmin: result.isAdmin,
          menuImportConfigured: result.menuImportConfigured,
          uploadsConfigured: result.uploadsConfigured,
          restaurants: result.restaurants,
          selectedId: result.restaurants[0]?.id ?? null,
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        const message = error instanceof Error ? error.message : "The owner dashboard could not be loaded.";
        dispatch({ type: "load-error", message });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!restaurantId) return;
    const controller = new AbortController();
    detailAbort.current?.abort();
    detailAbort.current = controller;
    void apiRequest<{
      restaurant: ManagedRestaurant;
      categories: ManagedMenuCategory[];
      imports: MenuImportJob[];
      hours: OpeningHours[];
    }>(`/api/owner/${encodeURIComponent(restaurantId)}`, { signal: controller.signal })
      .then((result) => {
        dispatch({
          type: "detail",
          restaurant: result.restaurant,
          categories: result.categories,
          imports: result.imports,
          hours: result.hours,
        });
        setRestaurantForm(restaurantFormFrom(result.restaurant));
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        dispatch({
          type: "error",
          message: error instanceof Error ? error.message : "The restaurant could not be loaded.",
        });
      });
    return () => controller.abort();
  }, [restaurantId]);

  const menuItemCount = useMemo(
    () => state.categories.reduce((total, category) => total + category.items.length, 0),
    [state.categories]
  );
  const filteredCategories = useMemo(() => {
    const query = menuQuery.trim().toLowerCase();
    if (!query && menuFilter === "all") return state.categories;
    return state.categories
      .map((category) => ({
        ...category,
        items: category.items.filter(
          (item) => (!query || item.name.toLowerCase().includes(query)) && matchesMenuFilter(item, menuFilter)
        ),
      }))
      .filter((category) => category.items.length > 0);
  }, [state.categories, menuQuery, menuFilter]);

  const selectedImport = useMemo(
    () => state.imports.find((job) => job.id === activeImportId) ?? null,
    [activeImportId, state.imports]
  );

  /** Returns the reloaded menu, so a caller can pick up the latest version of an item. */
  async function reloadCurrent(): Promise<ManagedMenuCategory[] | null> {
    const owner = await apiRequest<OwnerOverview>("/api/owner");
    const selected = owner.restaurants.find((item) => item.id === restaurantId) ?? owner.restaurants[0] ?? null;
    dispatch({
      type: "loaded",
      user: owner.user,
      isAdmin: owner.isAdmin,
      menuImportConfigured: owner.menuImportConfigured,
      uploadsConfigured: owner.uploadsConfigured,
      restaurants: owner.restaurants,
      selectedId: selected?.id ?? null,
    });
    if (!selected) return null;
    const detail = await apiRequest<{
      restaurant: ManagedRestaurant;
      categories: ManagedMenuCategory[];
      imports: MenuImportJob[];
      hours: OpeningHours[];
    }>(`/api/owner/${encodeURIComponent(selected.id)}`);
    dispatch({
      type: "detail",
      restaurant: detail.restaurant,
      categories: detail.categories,
      imports: detail.imports,
      hours: detail.hours,
    });
    setRestaurantForm(restaurantFormFrom(detail.restaurant));
    return detail.categories;
  }

  async function runTask(task: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    dispatch({ type: "busy", value: true });
    dispatch({ type: "error", message: null });
    dispatch({ type: "notice", message: null });
    try {
      await task();
    } catch (error) {
      dispatch({
        type: "error",
        message: error instanceof Error ? error.message : "The operation could not be completed.",
      });
    } finally {
      busyRef.current = false;
      dispatch({ type: "busy", value: false });
    }
  }

  async function createRestaurant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runTask(async () => {
      const payload = toRestaurantPayload(restaurantForm);
      const created = await apiRequest<{ restaurant: ManagedRestaurant }>("/api/owner", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      dispatch({ type: "loaded", user: state.user, isAdmin: state.isAdmin, menuImportConfigured: state.menuImportConfigured, uploadsConfigured: state.uploadsConfigured, restaurants: [...state.restaurants, created.restaurant], selectedId: created.restaurant.id });
      dispatch({ type: "notice", message: "Restaurant saved as a draft." });
    });
  }

  async function saveRestaurant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!restaurantId) return;
    await runTask(async () => {
      await apiRequest(`/api/owner/${encodeURIComponent(restaurantId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toRestaurantPayload(restaurantForm)),
      });
      await reloadCurrent();
      dispatch({ type: "notice", message: "Restaurant details saved." });
    });
  }

  async function toggleRestaurantPublication() {
    if (!restaurantId || !state.restaurant) return;
    const action = state.restaurant.status === "published" ? "unpublish" : "publish";
    await runTask(async () => {
      await apiRequest(`/api/owner/${encodeURIComponent(restaurantId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      await reloadCurrent();
      dispatch({
        type: "notice",
        message: action === "publish" ? "Restaurant published." : "Restaurant unpublished.",
      });
    });
  }

  async function addCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!restaurantId) return;
    await runTask(async () => {
      await apiRequest(`/api/owner/${encodeURIComponent(restaurantId)}/menu`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "category", name: categoryName }),
      });
      setCategoryName("");
      await reloadCurrent();
      dispatch({ type: "notice", message: "Menu category created." });
    });
  }

  async function saveItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!restaurantId) return;
    await runTask(async () => {
      const pricePaise = rupeesToPaise(itemForm.price);
      const discountedPricePaise = itemForm.discountedPrice ? rupeesToPaise(itemForm.discountedPrice) : null;
      const categoryId = itemForm.categoryId || state.categories[0]?.id;
      if (!categoryId) throw new Error("Create a menu category before saving a dish.");
      if (pricePaise === null || (itemForm.discountedPrice && discountedPricePaise === null)) {
        throw new Error("Enter valid prices in rupees, with up to two decimals.");
      }
      const variants = itemForm.variants.map((variant) => {
        const variantPrice = rupeesToPaise(variant.price);
        if (variantPrice === null || variantPrice < pricePaise) {
          throw new Error("Each portion price must be at least the base price.");
        }
        return {
          ...(variant.id ? { id: variant.id } : {}),
          name: variant.name,
          priceDeltaPaise: variantPrice - pricePaise,
        };
      });
      const addons = itemForm.addons.map((addon) => {
        const addonPrice = rupeesToPaise(addon.price);
        if (addonPrice === null) throw new Error("Enter a valid add-on price.");
        return { ...(addon.id ? { id: addon.id } : {}), name: addon.name, pricePaise: addonPrice };
      });
      try {
        await apiRequest(`/api/owner/${encodeURIComponent(restaurantId)}/menu`, {
          method: itemForm.id ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "item",
            ...(itemForm.id ? { id: itemForm.id, revision: itemForm.revision } : {}),
            categoryId,
            name: itemForm.name,
            description: itemForm.description,
            pricePaise,
            discountedPricePaise,
            portionSize: itemForm.portionSize,
            dietaryTags: itemForm.dietaryTags,
            allergens: itemForm.allergens.split(",").map((value) => value.trim()).filter(Boolean),
            available: itemForm.available,
            published: itemForm.published,
            featured: itemForm.featured,
            imageAssetId: itemForm.imageAssetId || null,
            variants,
            addons,
          }),
        });
      } catch (error) {
        // Someone saved this dish first: show their version instead of keeping a form
        // whose revision can never be saved.
        if (error instanceof ApiError && error.status === 409) {
          const categories = await reloadCurrent();
          const latest = categories?.flatMap((category) => category.items).find((item) => item.id === itemForm.id);
          setItemForm(latest ? itemFormFrom(latest) : blankItem(categories?.[0]?.id ?? ""));
        }
        throw error;
      }
      setItemForm(blankItem(state.categories[0]?.id ?? ""));
      await reloadCurrent();
      dispatch({ type: "notice", message: "Dish saved. Draft items remain hidden from customers." });
    });
  }

  function startEditing(item: ManagedMenuItem) {
    setItemForm(itemFormFrom(item));
    // The form sits below a long list; on a phone it would otherwise be off screen.
    requestAnimationFrame(() => {
      dishNameRef.current?.scrollIntoView({ block: "center" });
      dishNameRef.current?.focus({ preventScroll: true });
    });
  }

  async function toggleAvailability(item: ManagedMenuItem) {
    if (!restaurantId) return;
    await runTask(async () => {
      try {
        await apiRequest(`/api/owner/${encodeURIComponent(restaurantId)}/menu`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "itemAvailability",
            id: item.id,
            available: !item.available,
            revision: item.revision,
          }),
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) await reloadCurrent();
        throw error;
      }
      await reloadCurrent();
      const message = `${item.name} is now ${item.available ? "unavailable" : "available"}.`;
      dispatch({ type: "notice", message });
      announce(message);
    });
  }

  async function confirmDeleteItem() {
    const item = pendingDelete;
    if (!restaurantId || !item) return;
    setPendingDelete(null);
    await runTask(async () => {
      const search = new URLSearchParams({ itemId: item.id });
      await apiRequest(`/api/owner/${encodeURIComponent(restaurantId)}/menu?${search}`, { method: "DELETE" });
      if (itemForm.id === item.id) setItemForm(blankItem(state.categories[0]?.id ?? ""));
      await reloadCurrent();
      const message = `${item.name} was deleted.`;
      dispatch({ type: "notice", message });
      announce(message);
    });
  }

  async function uploadItemPhoto(file: File) {
    if (!restaurantId) return;
    await runTask(async () => {
      const data = new FormData();
      data.set("kind", "menu_item_image");
      data.set("file", file);
      const result = await apiRequest<{ assetId: string }>(
        `/api/owner/${encodeURIComponent(restaurantId)}/uploads`,
        { method: "POST", body: data }
      );
      setItemForm((current) => ({ ...current, imageAssetId: result.assetId }));
      dispatch({ type: "notice", message: "Photo uploaded. Save the dish to attach it." });
    });
  }

  async function uploadMenuPages(files: File[]) {
    if (!restaurantId || files.length === 0) return;
    await runTask(async () => {
      if (files.length > 10) throw new Error("Upload no more than 10 menu pages at once.");
      const failedFiles: File[] = [];
      const failures: string[] = [];
      let uploaded = 0;
      for (const file of files) {
        const data = new FormData();
        data.set("kind", "menu_document");
        data.set("file", file);
        try {
          await apiRequest(
            `/api/owner/${encodeURIComponent(restaurantId)}/uploads`,
            { method: "POST", body: data }
          );
          uploaded += 1;
        } catch (error) {
          failedFiles.push(file);
          failures.push(`${file.name}: ${error instanceof Error ? error.message : "Upload failed."}`);
        }
      }
      setMenuFiles(failedFiles);
      if (uploaded > 0) await reloadCurrent();
      if (failures.length) {
        dispatch({
          type: "notice",
          message: `${uploaded} menu page(s) saved. Failed files remain selected so you can retry them.`,
        });
        throw new Error(failures.join(" "));
      }
      dispatch({
        type: "notice",
        message: "Menu page(s) saved. Start extraction only when you're ready to review the AI-assisted draft.",
      });
    });
  }

  async function retryImport(importId: string) {
    if (!restaurantId) return;
    await runTask(async () => {
      await apiRequest(`/api/owner/${encodeURIComponent(restaurantId)}/imports/${encodeURIComponent(importId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "retry" }),
      });
      await reloadCurrent();
      dispatch({ type: "notice", message: "Menu extraction finished. Review every row before importing." });
    });
  }

  async function saveReviewDraft() {
    if (!restaurantId || !activeImportId) return;
    await runTask(async () => {
      await apiRequest(`/api/owner/${encodeURIComponent(restaurantId)}/imports/${encodeURIComponent(activeImportId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: reviewItems }),
      });
      await reloadCurrent();
      dispatch({ type: "notice", message: "Review edits saved. Nothing has been published." });
    });
  }

  async function importSelectedDrafts() {
    if (!restaurantId || !activeImportId) return;
    const selected = reviewItems.filter((item) => selectedDraftIds.includes(item.id));
    await runTask(async () => {
      const result = await apiRequest<{ imported: number; alreadyImported: boolean }>(
        `/api/owner/${encodeURIComponent(restaurantId)}/imports/${encodeURIComponent(activeImportId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "import", items: selected }),
        }
      );
      await reloadCurrent();
      dispatch({
        type: "notice",
        message: result.alreadyImported
          ? "These rows were already imported; no duplicates were created."
          : `${result.imported} dish(es) added as drafts. Publish them individually when ready.`,
      });
    });
  }

  function updateReviewItem(id: string, update: Partial<ExtractedMenuItem>) {
    setReviewItems((items) =>
      items.map((item) => {
        if (item.id !== id) return item;
        const updated = { ...item, ...update };
        const warnings = new Set(updated.warnings);
        if (updated.categoryName.trim()) warnings.delete("Category needs manual review.");
        if (updated.name.trim()) warnings.delete("Dish name needs manual review.");
        if (updated.pricePaise !== null) {
          warnings.delete("Price is unreadable or missing; enter it before importing.");
        }
        if (updated.variants.every((variant) => variant.name.trim() && variant.pricePaise !== null)) {
          warnings.delete("A variant name or price needs manual review.");
        }
        return { ...updated, warnings: [...warnings] };
      })
    );
  }

  if (state.phase === "loading") {
    return <main className="min-h-screen bg-[#0a0d12] p-8 text-white">Loading restaurant workspace…</main>;
  }

  return (
    <main className="min-h-screen bg-[#0a0d12] px-4 py-8 text-white sm:px-8">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <a href="/" className="inline-flex min-h-11 items-center text-sm text-emerald-300 hover:text-emerald-200">← KRAVE storefront</a>
            <h1 className="mt-2 text-3xl font-black tracking-tight">Restaurant workspace</h1>
            <p className="mt-1 text-sm text-slate-400">Manage your real menu. Imported dishes stay unpublished until you approve them.</p>
          </div>
          <div className="text-right text-sm text-slate-400">
            {state.user ? <><span>{state.user.displayName}</span><br /><span>{state.user.email}</span></> : null}
          </div>
        </header>

        {state.error ? <p role="alert" className="rounded-xl border border-red-400/40 bg-red-950/40 p-4 text-red-200">{state.error}</p> : null}
        {state.notice ? <p role="status" className="rounded-xl border border-emerald-400/30 bg-emerald-950/30 p-4 text-emerald-200">{state.notice}</p> : null}

        {state.phase === "error" ? (
          <section className="rounded-2xl border border-white/10 bg-[#121721] p-6">
            <p>{state.error}</p>
            {state.error?.includes("Sign in") ? <a className="mt-4 inline-block rounded-xl bg-emerald-700 px-4 py-2 font-bold" href="/">Sign in from the storefront</a> : null}
          </section>
        ) : !state.user ? (
          <section className="rounded-2xl border border-white/10 bg-[#121721] p-6">
            <h2 className="text-xl font-bold">Sign in to continue</h2>
            <p className="mt-2 text-slate-300">Use your KRAVE account. The server checks your restaurant membership before every change.</p>
            <a className="mt-4 inline-block rounded-xl bg-emerald-700 px-4 py-2 font-bold" href="/">Go to KRAVE sign-in</a>
          </section>
        ) : (
          <>
            {state.restaurants.length > 1 ? (
              <label className="block max-w-md text-sm font-semibold">
                Restaurant
                <select
                disabled={state.busy}
                className="mt-2 w-full rounded-xl border border-white/15 bg-[#121721] p-3"
                  value={restaurantId ?? ""}
                onChange={(event) => {
                  dispatch({ type: "select", id: event.target.value });
                  setItemForm(blankItem());
                  setActiveImportId(null);
                  setReviewItems([]);
                  setSelectedDraftIds([]);
                }}
                >
                  {state.restaurants.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
            ) : null}

            {!restaurantId ? (
              state.isAdmin ? (
                <form onSubmit={createRestaurant} className="space-y-5 rounded-2xl border border-white/10 bg-[#121721] p-6">
                  <div>
                    <h2 className="text-xl font-bold">Create Jagadamba Maratha Khanawali</h2>
                    <p className="mt-1 text-sm text-slate-400">This starts unpublished. Confirm the details from your real restaurant before publishing.</p>
                  </div>
                  <RestaurantFields form={restaurantForm} setForm={setRestaurantForm} />
                  <button disabled={state.busy} className="rounded-xl bg-emerald-700 px-5 py-3 font-bold disabled:opacity-50">
                    {state.busy ? "Saving…" : "Save restaurant draft"}
                  </button>
                </form>
              ) : (
                <section className="rounded-2xl border border-white/10 bg-[#121721] p-6">
                  <h2 className="text-xl font-bold">No restaurant is connected to this account</h2>
                  <p className="mt-2 text-slate-300">
                    Ask the restaurant&apos;s owner to add <strong className="text-white">{state.user.email}</strong> under
                    Team in their workspace. Waiters then take orders on the table POS.
                  </p>
                  <a className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-emerald-700 px-4 font-bold" href="/pos">Open table POS</a>
                </section>
              )
            ) : state.restaurant ? (
              <>
                <RestaurantOrdersPanel
                  key={`orders-${state.restaurant.id}`}
                  restaurantId={state.restaurant.id}
                  acceptingOrders={state.restaurant.acceptingOrders}
                />

                <section className="rounded-2xl border border-white/10 bg-[#121721] p-6">
                  <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-[.2em] text-emerald-300">Restaurant details</p>
                      <h2 className="mt-1 text-xl font-bold">{state.restaurant.name}</h2>
                    </div>
                    <span className="rounded-full border border-amber-300/30 px-3 py-1 text-xs font-bold uppercase text-amber-200">{state.restaurant.status}</span>
                  </div>
                  <form onSubmit={saveRestaurant} className="space-y-5">
                    <RestaurantFields form={restaurantForm} setForm={setRestaurantForm} />
                    <div className="flex flex-wrap gap-3">
                      <button disabled={state.busy} className="min-h-11 rounded-xl border border-white/20 px-4 font-bold disabled:opacity-50">Save details</button>
                      <button
                        type="button"
                        disabled={state.busy}
                        onClick={() => void toggleRestaurantPublication()}
                        className={`min-h-11 rounded-xl px-4 font-bold disabled:opacity-50 ${state.restaurant?.status === "published" ? "border border-amber-300/40 text-amber-100" : "bg-emerald-700"}`}
                      >
                        {state.restaurant.status === "published" ? "Unpublish restaurant" : "Publish restaurant"}
                      </button>
                      {state.restaurant.status === "published" ? <a className="rounded-xl border border-white/20 px-4 py-2 font-bold" href={`/r/${encodeURIComponent(state.restaurant.slug)}`} target="_blank" rel="noreferrer">Preview customer page</a> : null}
                    </div>
                  </form>
                </section>

                <RestaurantOrderingSettings
                  key={`ordering-${state.restaurant.id}-${state.restaurant.updatedAt}`}
                  restaurant={state.restaurant}
                  hours={state.hours}
                  onSaved={async (message) => {
                    await reloadCurrent();
                    dispatch({ type: "notice", message });
                  }}
                />

                <PosPinSettings key={`pin-${state.restaurant.id}`} restaurantId={state.restaurant.id} />

                <RestaurantTeamPanel key={`team-${state.restaurant.id}`} restaurantId={state.restaurant.id} />

                <section className="space-y-5 rounded-2xl border border-white/10 bg-[#121721] p-6">
                  <div>
                    <h2 className="text-xl font-bold">Menu</h2>
                    <p className="mt-1 text-sm text-slate-400">Prices are stored as integer paise. Unknown allergens remain undeclared; do not treat that as allergen-free.</p>
                  </div>

                  <form onSubmit={addCategory} className="flex flex-wrap gap-3">
                    <label className="sr-only" htmlFor="category-name">New category name</label>
                    <input id="category-name" value={categoryName} onChange={(event) => setCategoryName(event.target.value)} placeholder="e.g. Biryani" maxLength={80} required className="min-w-56 flex-1 rounded-xl border border-white/15 bg-[#0a0d12] px-3 py-2" />
                    <button disabled={state.busy} className="rounded-xl border border-emerald-300/40 px-4 py-2 font-bold text-emerald-200">Add category</button>
                  </form>

                  {state.categories.length === 0 ? <p className="rounded-xl border border-dashed border-white/20 p-5 text-slate-400">No categories yet. Create one or import your menu pages below.</p> : null}
                  {menuItemCount > 0 ? (
                    <div className="flex flex-wrap items-end gap-3" role="search" aria-label="Filter dishes">
                      <Field label="Search dishes"><input type="search" value={menuQuery} onChange={(event) => setMenuQuery(event.target.value)} placeholder="e.g. biryani" className="field min-w-56" /></Field>
                      <Field label="Show">
                        <select value={menuFilter} onChange={(event) => setMenuFilter(event.target.value as MenuFilter)} className="field">
                          <option value="all">All dishes</option>
                          <option value="published">Published</option>
                          <option value="draft">Drafts</option>
                          <option value="unavailable">Unavailable</option>
                        </select>
                      </Field>
                      <p className="pb-2 text-sm text-slate-400" aria-live="polite">
                        {filteredCategories.reduce((total, category) => total + category.items.length, 0)} of {menuItemCount} dishes
                      </p>
                    </div>
                  ) : null}
                  {menuItemCount > 0 && filteredCategories.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-white/20 p-5 text-slate-400">No dishes match this search.</p>
                  ) : null}
                  <div className="space-y-4">
                    {filteredCategories.map((category) => (
                      <div key={category.id} className="rounded-xl border border-white/10 p-4">
                        <h3 className="font-bold">{category.name}</h3>
                        {category.items.length === 0 ? <p className="mt-2 text-sm text-slate-400">No dishes in this category.</p> : (
                          <ul className="mt-3 divide-y divide-white/10">
                            {category.items.map((item) => (
                              <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                                <div className="min-w-0">
                                  <p className="font-semibold">{item.name} <span className="text-emerald-200">₹{paiseToRupees(item.discountedPricePaise ?? item.pricePaise)}</span></p>
                                  <p className="text-xs text-slate-400">
                                    {item.published ? "Published" : "Draft"} · {item.available ? "Available" : "Unavailable"}
                                    {item.allergens.length ? ` · Allergens: ${item.allergens.join(", ")}` : " · Allergens undeclared"}
                                  </p>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  <button type="button" disabled={state.busy} onClick={() => void toggleAvailability(item)} aria-label={`${item.available ? "Mark unavailable" : "Mark available"}: ${item.name}`} className="min-h-11 rounded-lg border border-white/20 px-3 text-sm disabled:opacity-50">{item.available ? "Mark unavailable" : "Mark available"}</button>
                                  <button type="button" onClick={() => startEditing(item)} aria-label={`Edit ${item.name}`} className="min-h-11 rounded-lg border border-white/20 px-3 text-sm">Edit</button>
                                  <button type="button" disabled={state.busy} onClick={() => setPendingDelete(item)} aria-label={`Delete ${item.name}`} className="min-h-11 rounded-lg border border-rose-300/30 px-3 text-sm text-rose-200 disabled:opacity-50">Delete</button>
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                  <OverlayDialog isOpen={pendingDelete !== null} onClose={() => setPendingDelete(null)} label="Delete dish">
                    <div className="rounded-2xl border border-white/15 bg-[#121721] p-6 text-slate-100">
                      <h2 className="text-lg font-bold">Delete {pendingDelete?.name}?</h2>
                      <p className="mt-2 text-sm text-slate-300">This removes the dish, its portions and add-ons, and cannot be undone. To hide it for now, mark it unavailable or unpublish it instead.</p>
                      <div className="mt-5 flex flex-wrap justify-end gap-3">
                        <button type="button" autoFocus onClick={() => setPendingDelete(null)} className="min-h-11 rounded-xl border border-white/20 px-4 font-bold">Keep dish</button>
                        <button type="button" onClick={() => void confirmDeleteItem()} className="min-h-11 rounded-xl bg-rose-600 px-4 font-bold text-white">Delete dish</button>
                      </div>
                    </div>
                  </OverlayDialog>

                  {state.categories.length > 0 ? (
                    <form onSubmit={saveItem} className="space-y-4 rounded-xl border border-emerald-300/20 bg-black/20 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="font-bold">{itemForm.id ? "Edit dish" : "Add a dish"}</h3>
                        {itemForm.id ? <button type="button" onClick={() => setItemForm(blankItem(state.categories[0]?.id ?? ""))} className="text-sm text-slate-300 underline">Cancel edit</button> : null}
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Dish name"><input ref={dishNameRef} required maxLength={120} value={itemForm.name} onChange={(event) => setItemForm({ ...itemForm, name: event.target.value })} className="field" /></Field>
                        <Field label="Category"><select required value={itemForm.categoryId || state.categories[0]?.id || ""} onChange={(event) => setItemForm({ ...itemForm, categoryId: event.target.value })} className="field">{state.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field>
                        <Field label="Price (₹)"><input required inputMode="decimal" type="number" min="0" step="0.01" value={itemForm.price} onChange={(event) => setItemForm({ ...itemForm, price: event.target.value })} className="field" /></Field>
                        <Field label="Discounted price (optional, ₹)"><input inputMode="decimal" type="number" min="0" step="0.01" value={itemForm.discountedPrice} onChange={(event) => setItemForm({ ...itemForm, discountedPrice: event.target.value })} className="field" /></Field>
                        <Field label="Portion / serving"><input maxLength={80} value={itemForm.portionSize} onChange={(event) => setItemForm({ ...itemForm, portionSize: event.target.value })} className="field" /></Field>
                        <Field label="Allergens (only confirmed)"><input maxLength={500} value={itemForm.allergens} onChange={(event) => setItemForm({ ...itemForm, allergens: event.target.value })} placeholder="Comma-separated, or leave undeclared" className="field" /></Field>
                      </div>
                      <Field label="Description (optional)"><textarea maxLength={1000} value={itemForm.description} onChange={(event) => setItemForm({ ...itemForm, description: event.target.value })} className="field min-h-20" /></Field>
                      <fieldset className="flex flex-wrap gap-4 text-sm">
                        <legend className="mb-2 font-semibold">Dietary labels (confirm before selecting)</legend>
                        {["vegetarian", "non-vegetarian", "vegan", "contains-egg"].map((tag) => (
                          <label key={tag} className="flex min-h-11 items-center gap-2">
                            <input type="checkbox" className="h-5 w-5" checked={itemForm.dietaryTags.includes(tag)} onChange={(event) => setItemForm({ ...itemForm, dietaryTags: event.target.checked ? [...itemForm.dietaryTags, tag] : itemForm.dietaryTags.filter((value) => value !== tag) })} />
                            {tag.replace("-", " ")}
                          </label>
                        ))}
                      </fieldset>
                      <div className="flex flex-wrap gap-4 text-sm">
                        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={itemForm.available} onChange={(event) => setItemForm({ ...itemForm, available: event.target.checked })} />Available</label>
                        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={itemForm.published} onChange={(event) => setItemForm({ ...itemForm, published: event.target.checked })} />Publish this dish</label>
                        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={itemForm.featured} onChange={(event) => setItemForm({ ...itemForm, featured: event.target.checked })} />Featured</label>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Dish photo (optional) — capture with your phone or upload">
                          <input type="file" disabled={!state.uploadsConfigured} accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadItemPhoto(file); }} className="field" />
                        </Field>
                        {itemForm.imageAssetId ? <p className="self-end text-sm text-emerald-200">Image stored and selected. Save the dish to attach it.</p> : <p className="self-end text-sm text-slate-400">No image is okay; customers see a neutral placeholder, not a stock photo.</p>}
                      </div>
                      <VariantEditor itemForm={itemForm} setItemForm={setItemForm} />
                      <AddonEditor itemForm={itemForm} setItemForm={setItemForm} />
                      <button disabled={state.busy} className="min-h-11 rounded-xl bg-emerald-700 px-5 py-2.5 font-bold disabled:opacity-50">{state.busy ? "Saving…" : itemForm.id ? "Save dish" : itemForm.published ? "Add and publish dish" : "Add dish as draft"}</button>
                    </form>
                  ) : null}
                </section>

                <section className="space-y-4 rounded-2xl border border-white/10 bg-[#121721] p-6">
                  <div>
                    <h2 className="text-xl font-bold">Import menu with AI</h2>
                    <p className="mt-1 text-sm text-slate-400">Upload up to 10 pages per batch, one file per page. Supported: PDF, JPEG, PNG, WebP; each file up to 4 MB. Menu files are private. AI output is untrusted and never publishes dishes.</p>
                  </div>
                  {!state.uploadsConfigured ? <p className="rounded-xl bg-amber-950/40 p-3 text-sm text-amber-100">File storage is not configured on this server, so menu pages and dish photos cannot be uploaded yet. You can still type dishes in by hand above.</p> : null}
                  {!state.menuImportConfigured ? <p className="rounded-xl bg-amber-950/40 p-3 text-sm text-amber-100">AI extraction needs the server-side OPENAI_API_KEY. Your files can still be retained, but extraction stays disabled until configured.</p> : null}
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="min-w-64 flex-1 text-sm font-semibold">
                      Menu pages or PDF
                      <input type="file" multiple disabled={!state.uploadsConfigured} accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(event) => setMenuFiles(Array.from(event.target.files ?? []))} className="field mt-2" />
                    </label>
                    <button type="button" disabled={state.busy || !state.uploadsConfigured || menuFiles.length === 0} onClick={() => void uploadMenuPages(menuFiles)} className="rounded-xl bg-emerald-700 px-4 py-2.5 font-bold disabled:opacity-50">
                      {state.busy ? "Uploading…" : `Upload ${menuFiles.length || ""} page(s)`}
                    </button>
                  </div>
                  <div className="space-y-3">
                    {state.imports.map((job) => (
                      <div key={job.id} className="rounded-xl border border-white/10 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <p className="font-semibold">{job.fileName}</p>
                            <p className="text-xs text-slate-400">{job.status} · {new Date(job.createdAt).toLocaleString()}</p>
                          </div>
                          <div className="flex gap-2">
                            {job.status === "failed" || job.status === "uploaded" ? <button type="button" disabled={state.busy || !state.menuImportConfigured} onClick={() => void retryImport(job.id)} className="rounded-lg border border-white/20 px-3 py-1.5 text-sm disabled:opacity-50">{job.status === "failed" ? "Retry extraction" : "Extract menu"}</button> : null}
                            {job.extractedItems.length ? <button type="button" onClick={() => { setActiveImportId(job.id); setReviewItems(job.extractedItems); setSelectedDraftIds(job.extractedItems.map((item) => item.id)); }} className="rounded-lg border border-emerald-300/30 px-3 py-1.5 text-sm text-emerald-200">Review {job.extractedItems.length} rows</button> : null}
                          </div>
                        </div>
                        {job.errorMessage ? <p role="alert" className="mt-2 text-sm text-amber-200">{job.errorMessage}</p> : null}
                        {job.status === "imported" ? <p className="mt-2 text-xs text-emerald-200">Imported as draft items. They remain hidden until each dish is explicitly published.</p> : null}
                      </div>
                    ))}
                    {state.imports.length === 0 ? <p className="text-sm text-slate-400">No menu pages uploaded yet.</p> : null}
                  </div>

                  {selectedImport && reviewItems.length ? (
                    <div className="space-y-4 rounded-xl border border-amber-300/20 bg-black/20 p-4">
                      <div>
                        <h3 className="font-bold">Review extraction — {selectedImport.fileName}</h3>
                        <p className="text-sm text-slate-400">Check names, portions and every price against the original. Blank prices must be corrected before import. Similar rows are kept separate and flagged, not merged.</p>
                      </div>
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={selectedDraftIds.length === reviewItems.length} onChange={(event) => setSelectedDraftIds(event.target.checked ? reviewItems.map((item) => item.id) : [])} />
                        Select all rows
                      </label>
                      <div className="space-y-3">
                        {reviewItems.map((item) => (
                          <article key={item.id} className="space-y-2 rounded-lg border border-white/10 p-3">
                            <label className="flex items-start gap-2">
                              <input type="checkbox" className="mt-1" checked={selectedDraftIds.includes(item.id)} onChange={(event) => setSelectedDraftIds((ids) => event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id))} />
                              <span className="text-xs text-slate-400">Page {item.sourcePage} · confidence {item.confidence === null ? "unknown" : `${Math.round(item.confidence * 100)}%`}</span>
                            </label>
                            <div className="grid gap-2 sm:grid-cols-3">
                              <label className="text-xs text-slate-400">Category<input aria-label="Category" value={item.categoryName} onChange={(event) => updateReviewItem(item.id, { categoryName: event.target.value })} className="field mt-1" /></label>
                              <label className="text-xs text-slate-400">Dish name<input aria-label="Dish name" value={item.name} onChange={(event) => updateReviewItem(item.id, { name: event.target.value })} className="field mt-1" /></label>
                              <label className="text-xs text-slate-400">Price (₹)<input aria-label="Price in rupees" inputMode="decimal" type="number" min="0" step="0.01" value={paiseToRupees(item.pricePaise)} onChange={(event) => updateReviewItem(item.id, { pricePaise: rupeesToPaise(event.target.value) })} className="field mt-1" /></label>
                            </div>
                            <label className="block text-xs text-slate-400">Description<textarea aria-label="Description" value={item.description} onChange={(event) => updateReviewItem(item.id, { description: event.target.value })} className="field mt-1 min-h-14" /></label>
                            <div className="grid gap-2 sm:grid-cols-2">
                              <label className="text-xs text-slate-400">Explicit dietary labels<input aria-label="Dietary labels" value={item.dietaryTags.join(", ")} onChange={(event) => updateReviewItem(item.id, { dietaryTags: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} className="field mt-1" /></label>
                              <label className="text-xs text-slate-400">Allergens (only if confirmed)<input aria-label="Allergens" value={item.allergens.join(", ")} onChange={(event) => updateReviewItem(item.id, { allergens: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} className="field mt-1" /></label>
                            </div>
                            <div className="space-y-2 rounded-lg bg-white/5 p-3">
                              <p className="text-xs font-semibold text-slate-300">Portions and prices</p>
                              {item.variants.map((variant, variantIndex) => (
                                <div key={`${item.id}-variant-${variantIndex}`} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                                  <label className="text-xs text-slate-400">Portion<input aria-label={`Portion ${variantIndex + 1}`} value={variant.name} onChange={(event) => updateReviewItem(item.id, { variants: item.variants.map((entry, index) => index === variantIndex ? { ...entry, name: event.target.value } : entry) })} className="field mt-1" /></label>
                                  <label className="text-xs text-slate-400">Price (₹)<input aria-label={`Portion price ${variantIndex + 1}`} inputMode="decimal" type="number" min="0" step="0.01" value={paiseToRupees(variant.pricePaise)} onChange={(event) => updateReviewItem(item.id, { variants: item.variants.map((entry, index) => index === variantIndex ? { ...entry, pricePaise: rupeesToPaise(event.target.value) } : entry) })} className="field mt-1" /></label>
                                  <button type="button" onClick={() => updateReviewItem(item.id, { variants: item.variants.filter((_, index) => index !== variantIndex) })} className="self-end rounded-lg border border-white/20 px-3 py-2 text-sm">Remove</button>
                                </div>
                              ))}
                              <button type="button" disabled={item.variants.length >= 20} onClick={() => updateReviewItem(item.id, { variants: [...item.variants, { name: "", pricePaise: null }] })} className="min-h-11 text-sm text-emerald-200 underline disabled:opacity-50">Add portion</button>
                            </div>
                            <p className="text-xs text-slate-400">Source: {item.sourceText || "No source excerpt returned"}</p>
                            {item.warnings.length ? <ul className="list-inside list-disc text-xs text-amber-200">{item.warnings.map((warning, index) => <li key={`${item.id}-${index}`}>{warning}</li>)}</ul> : null}
                          </article>
                        ))}
                      </div>
                      <div className="flex flex-wrap gap-3">
                        <button type="button" disabled={state.busy} onClick={() => void saveReviewDraft()} className="rounded-lg border border-white/20 px-4 py-2 font-semibold">Save review corrections</button>
                        <button type="button" disabled={state.busy || selectedDraftIds.length === 0} onClick={() => void importSelectedDrafts()} className="rounded-lg bg-emerald-700 px-4 py-2 font-bold disabled:opacity-50">Import selected as drafts</button>
                      </div>
                    </div>
                  ) : null}
                </section>
              </>
            ) : (
              <p className="rounded-xl border border-white/10 bg-[#121721] p-5">Loading selected restaurant…</p>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-sm font-semibold">{label}{children}</label>;
}

function RestaurantFields({
  form,
  setForm,
}: {
  form: RestaurantForm;
  setForm: React.Dispatch<React.SetStateAction<RestaurantForm>>;
}) {
  const update = <K extends keyof RestaurantForm>(key: K, value: RestaurantForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Restaurant name"><input required maxLength={120} value={form.name} onChange={(event) => update("name", event.target.value)} className="field" /></Field>
        <Field label="URL slug"><input required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxLength={80} value={form.slug} onChange={(event) => update("slug", event.target.value)} className="field" /></Field>
        <Field label="Phone (optional)"><input type="tel" maxLength={40} value={form.phone} onChange={(event) => update("phone", event.target.value)} className="field" /></Field>
        <Field label="Email (optional)"><input type="email" maxLength={160} value={form.email} onChange={(event) => update("email", event.target.value)} className="field" /></Field>
        <Field label="Address"><input maxLength={300} value={form.address} onChange={(event) => update("address", event.target.value)} className="field" /></Field>
        <Field label="Serviceable delivery areas (comma-separated)"><input maxLength={1000} value={form.serviceAreas} onChange={(event) => update("serviceAreas", event.target.value)} className="field" /></Field>
        <Field label="City"><input maxLength={100} value={form.city} onChange={(event) => update("city", event.target.value)} className="field" /></Field>
        <Field label="State"><input maxLength={100} value={form.state} onChange={(event) => update("state", event.target.value)} className="field" /></Field>
        <Field label="Postal code"><input maxLength={20} value={form.postalCode} onChange={(event) => update("postalCode", event.target.value)} className="field" /></Field>
        <Field label="Minimum order (₹)"><input type="number" min="0" step="0.01" value={form.minimumOrder} onChange={(event) => update("minimumOrder", event.target.value)} className="field" /></Field>
        <Field label="Delivery fee (₹)"><input type="number" min="0" step="0.01" value={form.deliveryFee} onChange={(event) => update("deliveryFee", event.target.value)} className="field" /></Field>
        <Field label="GST/tax rate (%)"><input type="number" min="0" max="100" step="0.01" value={form.taxRate} onChange={(event) => update("taxRate", event.target.value)} className="field" /></Field>
        <Field label="FSSAI licence number (printed on every bill)"><input inputMode="numeric" autoComplete="off" maxLength={20} placeholder="14 digits" value={form.fssaiNumber} onChange={(event) => update("fssaiNumber", event.target.value)} className="field" /></Field>
        <Field label="GSTIN (only if registered for GST)"><input autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={20} placeholder="e.g. 29ABCDE1234F1Z5" value={form.gstin} onChange={(event) => update("gstin", event.target.value)} className="field" /></Field>
      </div>
      <Field label="Description"><textarea maxLength={2000} value={form.description} onChange={(event) => update("description", event.target.value)} className="field min-h-20" /></Field>
      <fieldset className="flex flex-wrap gap-4 text-sm">
        <legend className="mb-2 font-semibold">Service modes</legend>
        {([
          ["deliveryEnabled", "Delivery"],
          ["takeawayEnabled", "Takeaway"],
          ["dineInEnabled", "Dine-in"],
          ["taxEnabled", "Add this tax to online orders and table bills"],
        ] as const).map(([key, label]) => (
          <label key={key} className="flex min-h-11 items-center gap-2">
            <input type="checkbox" className="h-5 w-5" checked={form[key]} onChange={(event) => update(key, event.target.checked)} />
            {label}
          </label>
        ))}
      </fieldset>
    </>
  );
}

function VariantEditor({
  itemForm,
  setItemForm,
}: {
  itemForm: ReturnType<typeof blankItem> | ReturnType<typeof itemFormFrom>;
  setItemForm: React.Dispatch<React.SetStateAction<ReturnType<typeof blankItem> | ReturnType<typeof itemFormFrom>>>;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="font-semibold">Portion variants (optional)</legend>
      {itemForm.variants.map((variant, index) => (
        <div key={variant.id ?? index} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <input aria-label="Variant name" maxLength={80} value={variant.name} onChange={(event) => setItemForm((current) => ({ ...current, variants: current.variants.map((entry, row) => row === index ? { ...entry, name: event.target.value } : entry) }))} placeholder="Half / Full" className="field" />
          <input aria-label="Variant price in rupees" type="number" min="0" step="0.01" value={variant.price} onChange={(event) => setItemForm((current) => ({ ...current, variants: current.variants.map((entry, row) => row === index ? { ...entry, price: event.target.value } : entry) }))} placeholder="₹" className="field" />
          <button type="button" onClick={() => setItemForm((current) => ({ ...current, variants: current.variants.filter((_, row) => row !== index) }))} className="rounded-lg border border-white/20 px-3">Remove</button>
        </div>
      ))}
      <button type="button" onClick={() => setItemForm((current) => ({ ...current, variants: [...current.variants, { name: "", price: "" }] }))} className="min-h-11 text-sm text-emerald-200 underline">Add portion</button>
    </fieldset>
  );
}

function AddonEditor({
  itemForm,
  setItemForm,
}: {
  itemForm: ReturnType<typeof blankItem> | ReturnType<typeof itemFormFrom>;
  setItemForm: React.Dispatch<React.SetStateAction<ReturnType<typeof blankItem> | ReturnType<typeof itemFormFrom>>>;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="font-semibold">Add-ons (optional)</legend>
      {itemForm.addons.map((addon, index) => (
        <div key={addon.id ?? index} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <input aria-label="Add-on name" maxLength={80} value={addon.name} onChange={(event) => setItemForm((current) => ({ ...current, addons: current.addons.map((entry, row) => row === index ? { ...entry, name: event.target.value } : entry) }))} placeholder="Extra roti" className="field" />
          <input aria-label="Add-on price in rupees" type="number" min="0" step="0.01" value={addon.price} onChange={(event) => setItemForm((current) => ({ ...current, addons: current.addons.map((entry, row) => row === index ? { ...entry, price: event.target.value } : entry) }))} placeholder="₹" className="field" />
          <button type="button" onClick={() => setItemForm((current) => ({ ...current, addons: current.addons.filter((_, row) => row !== index) }))} className="rounded-lg border border-white/20 px-3">Remove</button>
        </div>
      ))}
      <button type="button" onClick={() => setItemForm((current) => ({ ...current, addons: [...current.addons, { name: "", price: "" }] }))} className="min-h-11 text-sm text-emerald-200 underline">Add extra</button>
    </fieldset>
  );
}
