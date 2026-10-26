import { createPrivateKey, sign } from "node:crypto";

function response(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

export default async (request) => {
  if (request.method !== "GET") return response(405, { error: "method_not_allowed" });
  try {
    const sessionId = new URL(request.url).searchParams.get("session_id");
    if (!sessionId || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return response(400, { error: "invalid_session_id" });
    const key = process.env.STRIPE_SECRET_KEY;
    const privateKey = process.env.SUPER_LIGHTNING_LICENSE_PRIVATE_KEY;
    if (!key || !privateKey) return response(503, { error: "licensing_not_configured" });
    const stripe = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { authorization: `Bearer ${key}`, "stripe-version": "2026-08-26.dahlia" }
    });
    const session = await stripe.json();
    if (!stripe.ok || session.payment_status !== "paid" || session.metadata?.product !== "super-lightning") {
      return response(409, { error: "payment_not_fulfilled" });
    }
    const claims = {
      product: "super-lightning",
      tier: session.metadata.tier,
      issuedTo: session.customer_details?.email || "Stripe customer",
      issuedAt: new Date().toISOString(),
      licenseId: session.id
    };
    const payload = Buffer.from(JSON.stringify(claims));
    return response(200, {
      payload: payload.toString("base64url"),
      signature: sign(null, payload, createPrivateKey(privateKey)).toString("base64url")
    });
  } catch {
    return response(502, { error: "license_retrieval_failed" });
  }
};
