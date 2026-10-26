const PRICE_BY_TIER = {
  individual: "STRIPE_INDIVIDUAL_PRICE_ID",
  business: "STRIPE_BUSINESS_PRICE_ID"
};

function response(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(body)
  };
}

export default async (request) => {
  if (request.method !== "POST") return response(405, { error: "method_not_allowed" });
  try {
    const { tier } = await request.json();
    const priceId = process.env[PRICE_BY_TIER[tier]];
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    if (!priceId || !stripeSecretKey) return response(503, { error: "checkout_not_configured" });

    const origin = new URL(request.url).origin;
    const form = new URLSearchParams({
      mode: "payment",
      success_url: `${origin}/thanks.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/#pricing`,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      "metadata[product]": "super-lightning",
      "metadata[tier]": tier,
      integration_identifier: `super_lightning_${crypto.randomUUID()}`
    });
    const stripe = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${stripeSecretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        "stripe-version": "2026-08-26.dahlia"
      },
      body: form
    });
    const payload = await stripe.json();
    if (!stripe.ok || !payload.url) return response(502, { error: "stripe_checkout_failed" });
    return response(200, { checkoutUrl: payload.url });
  } catch {
    return response(400, { error: "invalid_request" });
  }
};
