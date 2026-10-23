/** WCAG 2.x contrast for white text on a brand fill. */

const MIN_TEXT_CONTRAST = 4.5;

function parseHex(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const digits =
    match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join("") : match[1];
  return [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function luminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastWithWhite(hex: string): number | null {
  const rgb = parseHex(hex);
  return rgb ? 1.05 / (luminance(rgb) + 0.05) : null;
}

const toHex = (rgb: number[]) =>
  `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`.toUpperCase();

const cache = new Map<string, string>();

function shadeAgainstWhite(hex: string, minContrast: number): string {
  const key = `${minContrast}|${hex}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const rgb = parseHex(hex);
  let shade = hex;
  if (rgb && 1.05 / (luminance(rgb) + 0.05) < minContrast) {
    // Scaling toward black keeps the hue; 1% steps keep the shade as light as allowed.
    for (let scale = 0.99; scale >= 0; scale -= 0.01) {
      const rounded = rgb.map((value) => Math.round(value * scale)) as [number, number, number];
      if (1.05 / (luminance(rounded) + 0.05) >= minContrast) {
        shade = toHex(rounded);
        break;
      }
    }
  }
  if (cache.size > 64) cache.clear();
  cache.set(key, shade);
  return shade;
}

/**
 * The brand colour as a solid fill under white text: the colour itself when it is dark
 * enough, otherwise the lightest shade of the same hue that is. Every preset and most
 * picked colours are too light for white text at full strength. Input that is not a hex
 * colour (the custom field mid-edit) comes back unchanged.
 */
export function primaryFill(hex: string): string {
  return shadeAgainstWhite(hex, MIN_TEXT_CONTRAST);
}

/**
 * The brand colour as text or an icon on a light surface. A little darker than the fill,
 * because it often sits on a pale wash of itself rather than on pure white.
 */
export function primaryInk(hex: string): string {
  return shadeAgainstWhite(hex, 5.5);
}
