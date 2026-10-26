import type { Metadata } from "next";
import { cookies } from "next/headers";
import { PosTerminal } from "@/components/pos/PosTerminal";
import { getUserForToken, SESSION_COOKIE } from "@/lib/server/auth";
import { readMailConfig } from "@/lib/server/mailer";
import { listPosOutlets } from "@/lib/server/posCatalog";
import type { PosCatalog } from "@/lib/pos/posEngine";

export const metadata: Metadata = {
  title: "Dine-In Billing Terminal",
  description:
    "Point-of-sale terminal for table service: take orders, fire kitchen tickets, calculate GST bills and settle payments.",
  // A staff tool: nothing here is for search results.
  robots: { index: false, follow: false },
};

async function loadCatalog(token: string | undefined): Promise<PosCatalog> {
  try {
    const user = await getUserForToken(token);
    if (!user) return { status: "signed-out" };
    return { status: "ready", outlets: await listPosOutlets(user.id) };
  } catch {
    return { status: "unavailable" };
  }
}

/** A half-finished SMTP setup can send nothing, so the terminal offers WhatsApp and SMS only. */
function mailEnabled(): boolean {
  try {
    return readMailConfig() !== null;
  } catch {
    return false;
  }
}

export default async function PosPage() {
  // Read outside the try: cookies() is what marks this page as rendered per request.
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return <PosTerminal catalog={await loadCatalog(token)} mailEnabled={mailEnabled()} />;
}
