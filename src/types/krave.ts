export type DiscoveryTabKey = "delivery" | "dineout" | "nightlife";

export type DietaryType = "veg" | "non-veg" | "egg";

export interface BrandThemePreset {
  id: string;
  name: string;
  brandName: string;
  tagline: string;
  membershipName: string;
  primaryHex: string;
  primaryHoverHex: string;
  secondaryHex: string;
  goldHex: string;
  accentGradient: string;
  badgeBg: string;
  badgeText: string;
}

export interface LocationAddress {
  id: string;
  alias: "Home" | "Work" | "Other" | "Current";
  displayTitle: string;
  displaySubtitle: string;
  cityName: string;
  cityId: number;
  latitude: number;
  longitude: number;
  deliverySubzoneId: number;
  o2Serviceable: boolean;
  pincode: string;
}

export interface RatingDetail {
  rating_type: "DINING" | "DELIVERY";
  rating: string;
  reviewCount: string;
  subtext: string;
  color: string;
}

export interface ModifierOption {
  id: string;
  name: string;
  price: number;
  dietary: DietaryType;
  isDefault?: boolean;
}

export interface ModifierGroup {
  id: string;
  title: string;
  subtitle: string;
  required: boolean;
  minSelect: number;
  maxSelect: number;
  options: ModifierOption[];
}

export interface DishItem {
  id: string;
  name: string;
  price: number;
  default_price: number;
  desc: string;
  dietary: DietaryType;
  bestseller?: boolean;
  mustTry?: boolean;
  spiceLevel?: "Mild" | "Medium" | "Fiery";
  calories?: number;
  prepTimeMins?: number;
  /**
   * What the kitchen has declared this contains. Absent means not declared, which is not
   * the same as containing nothing — nothing in the product may treat it as "safe".
   */
  allergens?: string[];
  /** Declared serving size. Absent means the kitchen has not said. */
  portion?: {
    /** Grams or millilitres as served. */
    grams?: number;
    /** How many people the kitchen says this feeds. */
    serves?: number;
  };
  rating?: {
    value: string;
    votes: string;
  };
  item_image_url: string;
  modifier_group_ids: string[];
}

export interface MenuSubCategory {
  id: string;
  name: string;
  items: DishItem[];
}

export interface MenuCategory {
  id: string;
  name: string;
  categories: MenuSubCategory[];
}

export interface RestaurantReview {
  id: string;
  userName: string;
  userAvatar: string;
  userHandle: string;
  reviewType: "DINING" | "DELIVERY";
  rating: number;
  timestamp: string;
  comment: string;
  positiveTags: string[];
  likes: number;
  photos?: string[];
  /** True only when the server matched this reviewer to an order or booking here. */
  verifiedPurchase?: boolean;
}

export interface DiningSlot {
  time: string;
  mealType: "Lunch" | "Dinner";
  discountText: string;
  seatsLeft: number;
}

export interface RestaurantEntity {
  resId: number;
  slug: string;
  name: string;
  heroImage: string;
  galleryImages: string[];
  cuisines: string[];
  costForTwo: number;
  costForTwoText: string;
  locality: string;
  city: string;
  address: string;
  distanceKm: number;
  distanceText: string;
  deliveryTimeMins: number;
  deliveryTimeText: string;
  isPromoted: boolean;
  pureVeg: boolean;
  hygieneRating: string;
  hyperpureVerified: boolean;
  fssaiLicense: string;
  modes: DiscoveryTabKey[];
  collectionIds: number[];
  offers: {
    code: string;
    title: string;
    subtitle: string;
    discountType: "PERCENT" | "FLAT";
    value: number;
    maxDiscount?: number;
    minOrder: number;
  }[];
  walkinOffer: {
    title: string;
    goldExtraPercent: number;
    basePercent: number;
  };
  ratings: {
    DINING: RatingDetail;
    DELIVERY: RatingDetail;
  };
  openingHours: string;
  isOpen: boolean;
  menus: MenuCategory[];
  modifierGroups: Record<string, ModifierGroup>;
  diningSlots: DiningSlot[];
  reviews: RestaurantReview[];
  highlights: string[];
}

export interface CollectionEntity {
  id: number;
  name: string;
  subtitle: string;
  placesCount: string;
  tag: string;
  image: string;
  modes: DiscoveryTabKey[];
}

export interface TopBrandEntity {
  id: string;
  name: string;
  logoText: string;
  accentColor: string;
  deliveryTime: string;
  resId: number;
  image: string;
}

export interface CartLineItem {
  lineItemId: string;
  resId: number;
  restaurantName: string;
  item: DishItem;
  quantity: number;
  selectedOptions: ModifierOption[];
  unitPrice: number;
  cookingInstruction?: string;
}

export interface CouponOffer {
  code: string;
  title: string;
  description: string;
  bankOrPartner: string;
  discountType: "PERCENT" | "FLAT";
  value: number;
  maxDiscount: number;
  minOrder: number;
  membersOnly?: boolean;
  /** Must match one of `DEMO_PAYMENT_METHODS`. */
  requiresPaymentMethod?: string;
  firstOrderOnly?: boolean;
}

export interface CartQuote {
  quoteId: string;
  resId: number | null;
  itemCount: number;
  itemTotal: number;
  couponCode: string | null;
  couponDiscount: number;
  goldDiscount: number;
  packagingFee: number;
  platformFee: number;
  deliveryFee: number;
  gstAndCharges: number;
  riderTip: number;
  /** Taken off when a price lock beat the current price. Shown, never silent. */
  lockAdjustment: number;
  grandTotal: number;
  totalSavings: number;
}

export type CrystalOrderStage =
  | "ORDER_CONFIRMED"
  | "KITCHEN_PREPARING"
  | "RIDER_ASSIGNED"
  | "OUT_FOR_DELIVERY"
  | "ARRIVED";

export interface CrystalOrderState {
  orderId: string;
  resId: number;
  restaurantName: string;
  restaurantLocality: string;
  customerAddress: LocationAddress;
  items: CartLineItem[];
  quote: CartQuote;
  paymentMethod: string;
  zpaykitTransactionId: string;
  stage: CrystalOrderStage;
  etaMinutes: number;
  /** Requested delivery window; "ASAP" means no scheduling was asked for. */
  scheduledSlot: string;
  /** Structured handling the kitchen must act on, printed on the ticket. */
  handling: { flags: string[]; allergyNote: string };
  placedAt: string;
  rider: {
    name: string;
    phone: string;
    rating: string;
    deliveriesCount: number;
    vehicleNumber: string;
    vaccinated: boolean;
    temperatureText: string;
    progressPercent: number;
  };
}

export interface DiningReservation {
  bookingId: string;
  resId: number;
  restaurantName: string;
  locality: string;
  date: string;
  timeSlot: string;
  mealType: "Lunch" | "Dinner";
  guests: number;
  offerApplied: string;
  specialRequest: string;
  guestName: string;
  guestPhone: string;
  status: "CONFIRMED";
  createdAt: string;
}

export interface ZPayKitEventRecord {
  id: string;
  timestamp: string;
  direction: "HOST_TO_WIDGET" | "WIDGET_TO_HOST";
  topic: "widget_on_load" | "widget_status" | "change_billing_details" | "pay_button_clicked";
  payload: Record<string, unknown>;
}
