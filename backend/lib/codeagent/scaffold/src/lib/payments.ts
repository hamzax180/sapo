/* =================================================================
   payments.ts — take a real Stripe payment from inside this app
   -----------------------------------------------------------------
   Part of the fixed scaffold. Import it; do not rewrite it.

   How the money moves: the app owner connects their own Stripe
   account to Souqi, and Souqi creates the Checkout Session ON that
   account. The money is the owner's. This file never sees a card, a
   Stripe key, or an amount — it names an ITEM and the server looks
   up what that costs.

   That last part is deliberate and is why there is no `amount`
   parameter here to reach for: this code ships to a browser, so any
   price it could name is a price a shopper could edit.
   ================================================================= */

export type PaymentItem = {
  id: string;
  name: string;
  /** Price in minor units — 1250 means 12.50, never 12.5. */
  amountMinor: number;
  /** Lowercase ISO-4217, e.g. "usd", "eur", "try". */
  currency: string;
};

type SouqiApp = { id: string; origin: string };

declare global {
  interface Window {
    __SOUQI_APP__?: SouqiApp;
  }
}

/**
 * Souqi injects this into the published page. It is absent while the app is
 * still a live preview, which is not a bug — there is no published app to
 * bill against yet.
 */
function app(): SouqiApp | null {
  const a = typeof window !== "undefined" ? window.__SOUQI_APP__ : undefined;
  return a && a.id ? a : null;
}

/** True once this app is published and its owner has connected Stripe. */
export function paymentsAvailable(): boolean {
  return app() !== null;
}

/** Format minor units for display. Falls back gracefully on odd currencies. */
export function formatPrice(amountMinor: number, currency: string): string {
  const value = amountMinor / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(value);
  } catch {
    return value.toFixed(2) + " " + currency.toUpperCase();
  }
}

/**
 * What this app sells, as configured by its owner in Souqi settings.
 *
 * Fetch this rather than hardcoding a price list: the owner can change prices
 * without the app being rebuilt, and a hardcoded list silently goes stale.
 */
export async function listItems(): Promise<{ items: PaymentItem[]; acceptsPayments: boolean }> {
  const a = app();
  if (!a) return { items: [], acceptsPayments: false };
  try {
    const res = await fetch(a.origin + "/api/apps/" + encodeURIComponent(a.id) + "/payment-items");
    if (!res.ok) return { items: [], acceptsPayments: false };
    return await res.json();
  } catch {
    return { items: [], acceptsPayments: false };
  }
}

export type CheckoutLine = { itemId: string; quantity?: number };

/**
 * Send the shopper to Stripe Checkout.
 *
 * On success this NAVIGATES AWAY — treat any code after the await as
 * unreachable on the happy path, and put "processing…" UI before the call
 * rather than after it. Returns an error string when it could not start.
 *
 *   const err = await checkout([{ itemId: "latte", quantity: 2 }]);
 *   if (err) setError(err);
 */
export async function checkout(lines: CheckoutLine[]): Promise<string | null> {
  const a = app();
  if (!a) return "Payments work once this app is published.";
  if (!lines || !lines.length) return "Nothing to pay for.";

  try {
    const res = await fetch(a.origin + "/api/apps/" + encodeURIComponent(a.id) + "/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: lines })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) return (data && data.error) || "Could not start checkout.";
    window.location.href = data.url;
    return null;
  } catch {
    return "Could not reach the payment service.";
  }
}
