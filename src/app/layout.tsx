import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";

export const metadata: Metadata = {
  title: "KRAVE — Local restaurants, their own menus and prices",
  description:
    "Menus and prices published by local restaurants themselves. Order online where a restaurant has switched it on, or eat in and keep your bill.",
  appleWebApp: { capable: true, title: "KRAVE", statusBarStyle: "black-translucent" },
  icons: { icon: { url: "/icon.svg", type: "image/svg+xml" } },
};

export const viewport: Viewport = {
  themeColor: "#10B981",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
