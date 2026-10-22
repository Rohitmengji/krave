import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "KRAVE — Delivery, Dining & Dine-In Terminal",
    short_name: "KRAVE",
    description:
      "Independent food delivery, dining and offline dine-in billing prototype. Demo checkout only.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0A0D12",
    theme_color: "#10B981",
    categories: ["food", "business"],
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
    shortcuts: [
      {
        name: "Dine-In Billing Terminal",
        short_name: "Table POS",
        url: "/pos",
      },
    ],
  };
}
