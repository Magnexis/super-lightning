import { createHmac, timingSafeEqual } from "node:crypto";

function response(statusCode, body) {
  return { statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(body) };
}

export default async (request) => {
  if (request.method !== "POST") return response(405, { error: "method_not_allowed" });
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const signatureHeader = request.headers.get("stripe-signature") || "";
  const raw = await request.text();
  const timestamp = /(?:^|,)t=(\d+)/.exec(signatureHeader)?.[1];
  const signature = /(?:^|,)v1=([a-f0-9]+)/.exec(signatureHeader)?.[1];
  if (!secret || !timestamp || !signature || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return response(400, { error: "invalid_signature" });
  const expected = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  if (expected.length !== signature.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return response(400, { error: "invalid_signature" });
  return response(200, { received: true });
};
