import type { Metadata } from "next";
import { KraveApp } from "@/components/KraveApp";

export const metadata: Metadata = {
  title: "Sign in — KRAVE",
  description: "Sign in to keep orders, bookings and bookmarks on your KRAVE account.",
  robots: { index: false, follow: true },
};

export default function SignInPage() {
  return <KraveApp initialView="signin" />;
}
