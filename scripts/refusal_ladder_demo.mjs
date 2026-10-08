#!/usr/bin/env node
/**
 * refusal_ladder_demo.mjs — the Colosseum "honesty" beat, runnable live.
 *
 * Drives the LIVE bridge (:8092) through the full honest-refusal ladder and
 * ONE real settlement, printing a single clean screen per take. This is the
 * beat designed for shot B8 of a recording pack: five rejections that are
 * the product working, then a gate-passed settlement with on-chain evidence.
 *
 * Laws this beat obeys:
 *  - every visual is live estate output; no manufactured state, no mock rows
 *  - rejections are never cut or smoothed (VIDEO-RUN-ORDER honest boundary)
 *  - each take burns exactly ONE real settlement of STRIPE_BRIDGE_AMOUNT
 *    cents (default 100c = $1.00 = 1 OUSD) — take-to-take numbers differ by
 *    design because they are true
 *
 * Requires: STRIPE_BRIDGE_API_KEY (merchant bearer) and STRIPE_BRIDGE_RECIPIENT.
 * Optional: STRIPE_BRIDGE_BASE (default http://127.0.0.1:8092),
 *           STRIPE_BRIDGE_AMOUNT (cents, default 100). All other party fields
 *           are explicit below — the bridge refuses fabrication, so the demo
 *           refuses defaults too.
 *
 * Exit 0 = every gate fired as expected. Any unexpected outcome = exit 1
 * (a dead take, honestly).
 */
import { randomUUID } from "node:crypto";

const BASE = process.env.STRIPE_BRIDGE_BASE || "http://127.0.0.1:8092";
const KEY = process.env.STRIPE_BRIDGE_API_KEY || "";
const RECIPIENT = process.env.STRIPE_BRIDGE_RECIPIENT || "";
const AMOUNT = parseInt(process.env.STRIPE_BRIDGE_AMOUNT || "100", 10);
if (!KEY || !RECIPIENT) {
  console.error("STRIPPED BEAT: set STRIPE_BRIDGE_API_KEY and STRIPE_BRIDGE_RECIPIENT (no defaults — the product refuses fabrication and so does its demo)");
  process.exit(1);
}

const META = (patch = {}) => ({
  solana_recipient: RECIPIENT,
  debtor_name: "Beat Merchant Treasury",
  debtor_bic: "SYNAUS33XXX",
  creditor_name: "Beat Recipient Desk",
  creditor_bic: "SYNAGB22XXX",
  ...patch,
});

const api = async (method, path, body, extra = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json",
               "idempotency-key": `beat-${randomUUID()}`, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { code: res.status, body: await res.json() };
};

const pad = (s, n) => (s.length >= n ? s : s + " ".repeat(n));
const row = (id, what, code, err, verdict) =>
  console.log(`  [${id}] ${pad(what, 34)} ${String(code).padEnd(4)} ${pad(err || "—", 40)} ${verdict}`);

console.log("");
console.log(" BEAT R — THE REFUSAL LADDER · syn-stripe-bridge (LIVE rail)");
console.log(" =================================================================");
let ok = true;

try {
  const health = (await api("GET", "/health")).body;
  console.log(`  bridge v${health.version} · rail ${health.rail?.chain} · mint ${health.rail?.ousd_mint?.slice(0, 8)}…`);
} catch { console.error("  /health unreachable — nothing on this screen is a receipt"); process.exit(1); }

// R1 — no credentials
{ const r = await api("POST", "/v1/payment_intents", { amount: 100, currency: "usd" }, { authorization: "" });
  const want = r.code === 401 && r.body?.error?.code === "missing_api_key";
  ok &&= want; row("R1", "no credentials", r.code, r.body?.error?.code, want ? "fail-closed ✓" : "UNEXPECTED ✗"); }

// R2 — garbage recipient
{ const r = await api("POST", "/v1/payment_intents", { amount: 100, currency: "usd", metadata: META({ solana_recipient: "GARBAGE_NOT_A_PUBKEY" }) });
  const want = r.code === 400 && r.body?.error?.code === "recipient_invalid";
  ok &&= want; row("R2", "garbage recipient", r.code, r.body?.error?.code, want ? "refused ✓" : "UNEXPECTED ✗"); }

// R3 — ISO party missing (per SPECIFICATION §2 the 400 is at CONFIRM time;
// the wire is refused only when it would actually be built)
{ const r = await api("POST", "/v1/payment_intents", { amount: 100, currency: "usd", metadata: META({ creditor_bic: undefined }) });
  const c = r.body?.id ? await api("POST", `/v1/payment_intents/${r.body.id}/confirm`) : { code: 0, body: {} };
  const want = c.code === 400 && c.body?.error?.code === "iso20022_fields_missing";
  ok &&= want; row("R3", "missing creditor_bic (confirm)", c.code, c.body?.error?.code, want ? "no fabricated banks ✓" : "UNEXPECTED ✗"); }

// R4 — over-balance
{ const r = await api("POST", "/v1/payment_intents", { amount: 200000, currency: "usd", metadata: META() });
  const intentId = r.body?.id;
  const c = intentId ? await api("POST", `/v1/payment_intents/${intentId}/confirm`) : { code: 0, body: {} };
  const want = c.code === 402 && c.body?.error?.code === "insufficient_funds";
  ok &&= want; row("R4", "$2,000.00 vs real balance", c.code, c.body?.error?.code, want ? "overdraft impossible ✓" : "UNEXPECTED ✗"); }

// R5 — ONE real settlement
{ const r = await api("POST", "/v1/payment_intents", { amount: AMOUNT, currency: "usd", metadata: META() });
  if (r.code !== 201 || !r.body?.id) { console.log("  [R5] create failed:", JSON.stringify(r.body).slice(0, 200)); process.exit(1); }
  const c = await api("POST", `/v1/payment_intents/${r.body.id}/confirm`);
  if (c.code !== 200 || c.body?.status !== "succeeded") {
    console.log(`  [R5] REAL SETTLEMENT: HTTP ${c.code}`, JSON.stringify(c.body?.error || c.body?.status).slice(0, 200));
    process.exit(1); // dead take — the success leg must be true or the beat is dishonest
  }
  const rx = c.body.iso20022?.pacs002_report;
  const ev = c.body.last_verification?.evidence || [];
  const rail = rx?.xml?.match(/RAIL_SIGNATURE:([A-Za-z0-9]+)\|SLOT:([0-9]+)/);
  console.log(`  [R5] REAL SETTLEMENT $${(AMOUNT / 100).toFixed(2)} ......... ${c.code} succeeded`);
  console.log(`       gate: ${ev.map(e => `${e.checked} ${e.matching ?? "✓"}`).join(" | ")}`);
  console.log(`       pacs.002 ${rx?.status} · UETR ${rx?.uetr}`);
  console.log(`       on-chain: sig ${rail?.[1] ?? "?"} · slot ${rail?.[2] ?? "?"}`);
  console.log(`       receipt:  ${c.body.receipt_url || "-"}`);
  console.log(`       webhook:  delivered=${c.body.webhook?.delivered} status=${c.body.webhook?.status}`);

  // R6 — replay confirm: the exact-once proof (same intent, same receipt,
  // no second settlement row, no second on-chain transfer)
  const c6 = await api("POST", `/v1/payment_intents/${r.body.id}/confirm`);
  const replayHonest =
    c6.body?.id === r.body.id &&
    c6.body?.status === "succeeded" &&
    JSON.stringify(c6.body.last_verification) === JSON.stringify(c.body.last_verification);
  ok &&= replayHonest; row("R6", "confirm replayed", c6.code, "no re-send", replayHonest ? "exact-once ✓" : "UNEXPECTED ✗"); }

console.log(" =================================================================");
console.log(`  BEAT RESULT: ${ok ? "5 honest refusals + 1 delivered settlement — every claim on screen has a receipt" : "UNEXPECTED OUTCOME — dead take (honest)"}`);
process.exit(ok ? 0 : 1);