"use client";

import { useEffect } from "react";

/**
 * Registers the offline shell worker. Kept out of production-only guards so the dine-in
 * terminal can be verified offline during local development too.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // An unavailable worker only costs offline support; the app still runs online.
      });
    };
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register);
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
