import type { ExtractedMenuItem } from "./restaurantStore";

interface ResponsesApiResponse {
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
  output_text?: string;
}

function nullablePrice(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 100_000_000) {
    return null;
  }
  return value;
}

function boundedText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function parseExtractedItems(value: unknown): ExtractedMenuItem[] {
  if (!value || typeof value !== "object" || !("items" in value) || !Array.isArray(value.items)) {
    throw new Error("The menu reader returned an unsupported result. Keep the file and retry.");
  }
  if (value.items.length > 250) {
    throw new Error("The menu reader found too many items to safely import in one batch.");
  }

  const items: ExtractedMenuItem[] = value.items.map((raw, index) => {
    const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const name = boundedText(row.name, 120);
    const categoryName = boundedText(row.category, 80);
    const pricePaise = nullablePrice(row.price_paise);
    const rawVariants = Array.isArray(row.variants) ? row.variants.slice(0, 20) : [];
    const warnings = Array.isArray(row.warnings)
      ? row.warnings.filter((warning): warning is string => typeof warning === "string").map((warning) => warning.slice(0, 200)).slice(0, 10)
      : [];
    if (!name) warnings.push("Dish name needs manual review.");
    if (!categoryName) warnings.push("Category needs manual review.");
    if (pricePaise === null) warnings.push("Price is unreadable or missing; enter it before importing.");

    const dietary = Array.isArray(row.dietary_tags) ? row.dietary_tags : [];
    const allowedDietary = new Set(["vegetarian", "non-vegetarian", "vegan", "contains-egg"]);
    const allergens = Array.isArray(row.allergens) ? row.allergens : [];
    const variants = rawVariants.map((rawVariant) => {
      const variant = (rawVariant && typeof rawVariant === "object" ? rawVariant : {}) as Record<string, unknown>;
      return {
        name: boundedText(variant.name, 80),
        pricePaise: nullablePrice(variant.price_paise),
      };
    });
    for (const variant of variants) {
      if (!variant.name || variant.pricePaise === null) {
        warnings.push("A variant name or price needs manual review.");
      }
    }

    return {
      id: `draft_${index + 1}`,
      categoryName,
      name,
      description: boundedText(row.description, 1000),
      pricePaise,
      dietaryTags: dietary
        .filter((tag): tag is string => typeof tag === "string" && allowedDietary.has(tag))
        .slice(0, 4),
      allergens: allergens
        .filter((allergen): allergen is string => typeof allergen === "string")
        .map((allergen) => allergen.slice(0, 80))
        .slice(0, 30),
      portionSize: boundedText(row.portion_size, 80),
      variants,
      sourcePage: Number.isSafeInteger(row.source_page) && Number(row.source_page) > 0 ? Number(row.source_page) : 1,
      sourceText: boundedText(row.source_text, 500),
      confidence:
        typeof row.confidence === "number" && Number.isFinite(row.confidence)
          ? Math.max(0, Math.min(1, row.confidence))
          : null,
      warnings: [...new Set(warnings)],
    };
  });

  const seen = new Map<string, number>();
  for (const item of items) {
    const key = `${item.categoryName.toLocaleLowerCase()}::${item.name.toLocaleLowerCase()}`;
    const previous = seen.get(key);
    if (previous !== undefined) {
      const notice = "Possible duplicate across this menu; verify whether this is a separate portion or variant.";
      items[previous].warnings = [...new Set([...items[previous].warnings, notice])];
      item.warnings = [...new Set([...item.warnings, notice])];
    } else {
      seen.set(key, items.indexOf(item));
    }
  }
  return items;
}

export async function extractMenuFromDocument(input: {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
}): Promise<ExtractedMenuItem[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("AI menu import is not configured. Set OPENAI_API_KEY to enable extraction.");
  }

  const isPdf = input.mimeType === "application/pdf";
  const dataUrl = `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`;
  const fileContent = isPdf
    ? { type: "input_file", filename: input.fileName, file_data: dataUrl, detail: "high" }
    : { type: "input_image", image_url: dataUrl, detail: "high" };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({
      model: process.env.OPENAI_MENU_MODEL || "gpt-4o-mini",
      store: false,
      max_output_tokens: 6000,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Extract menu entries from this real restaurant menu into JSON with one top-level key, items.",
                "Each item must have: category (string), name (string), description (string), price_paise (integer or null), dietary_tags (array of explicit labels only: vegetarian, non-vegetarian, vegan, contains-egg), allergens (array only when explicitly printed), portion_size (string), variants (array of {name, price_paise}), source_page (1-based page number), source_text (short exact text from the menu), confidence (0..1), warnings (array of strings).",
                "Never infer a price, ingredient, allergen, dietary label, description, or portion. If a price is unclear, use null and explain in warnings. Convert printed rupee prices to paise exactly. Preserve distinct portion prices as variants; do not merge similar names. Do not include restaurant ratings, offers, or promotional claims.",
                "The image/PDF may contain multiple columns or regional Indian scripts. Read the printed item names in the script they use when legible; do not invent translations. Keep each page number and source text for traceability.",
                "Output JSON only.",
              ].join("\n"),
            },
            fileContent,
          ],
        },
      ],
      text: { format: { type: "json_object" } },
    }),
  });

  if (!response.ok) {
    const status = response.status;
    throw new Error(
      status === 401 || status === 403
        ? "The AI provider rejected its configured API key. Your file is saved; check OPENAI_API_KEY."
        : "The AI provider could not read this menu right now. Your file is saved; retry the import."
    );
  }
  const payload = (await response.json()) as ResponsesApiResponse;
  const outputText =
    payload.output_text ??
    payload.output?.flatMap((entry) => entry.content ?? []).find((part) => part.type === "output_text")?.text;
  if (!outputText) throw new Error("The menu reader returned no extraction. Keep the file and retry.");
  let decoded: unknown;
  try {
    decoded = JSON.parse(outputText);
  } catch {
    throw new Error("The menu reader returned invalid data. Keep the file and retry.");
  }
  return parseExtractedItems(decoded);
}
