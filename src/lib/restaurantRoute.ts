import { RESTAURANTS_DATA } from "@/data/zomatoReconstructedData";
import type { RestaurantEntity } from "@/types/krave";

/**
 * Only the canonical spelling of an id resolves. Number() would also accept "010", "1e3",
 * "0x1F" and " 42", serving the same page at many URLs.
 */
export function findRestaurantByParam(param: string): RestaurantEntity | undefined {
  if (!/^[1-9]\d{0,15}$/.test(param)) return undefined;
  const resId = Number(param);
  return RESTAURANTS_DATA.find((candidate) => candidate.resId === resId);
}
