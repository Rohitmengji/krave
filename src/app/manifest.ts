import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "KRAVE — Restaurant menus and table billing",
    short_name: "KRAVE",
    description:
      "Menus and prices published by local restaurants, online ordering where a restaurant allows it, and a table billing terminal that keeps working offline.",
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
