#!/usr/bin/env node
/**
 * test_custodian_cap.mjs — the vendored custodian spend-cap port
 * (2026-10-10). Drives `reserveCustodianSpend` from ../vendor/solana-tx.mjs
 * against a TEMP state file and a SYNTHETIC 64-int "keypair" (never a real
 * key): the per-era cap math, the exact refusal vocabulary, the
 * non-default-keyfile exemption, the era reset, and — vendor-specific —
 * reserve-before-loadKeypair ordering inside solanaPayout and the unchanged
 * existing export surface (ata.mjs and stripe_shim.mjs consume it).
 * NO network, NO real keys, NO sends — the reserve throws before any
 * signature by construction.
 */
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "vencustcap-"));
// Synthetic key material (i*7+11 mod 256): deterministic garbage, live-key-proof.
const synth = Array.from({ length: 64 }, (_, i) => (i * 7 + 11) % 256);
writeFileSync(join(dir, "cust.json"), JSON.stringify(synth));
process.env.SOLANA_CUSTODIAN_KEY_FILE = join(dir, "cust.json");
delete process.env.SOLANA_CUSTODIAN_ERA;
process.env.SOLANA_CUSTODIAN_SPEND_FILE = join(dir, "spend.json");
process.env.SOLANA_CUSTODIAN_MAX_SPEND_ERA = "1000";
const vendor = await import("../vendor/solana-tx.mjs");
const { reserveCustodianSpend, solanaPayout } = vendor;

let pass = 0; const fail = [];
const gate = (name, fn) => Promise.resolve().then(fn).then(
  () => { console.log(`PASS ${name}`); pass++; },
  (e) => fail.push(`${name}: ${(e && e.message) || e}`));

await gate("cap refusal lands BEFORE any reservation, exact upstream vocabulary", () => {
  const r1 = reserveCustodianSpend({ custodianPath: join(dir, "cust.json"), lamports: 600 });
  assert.equal(r1.cap_lamports, 1000);
  assert.equal(r1.spent_lamports, 600);
  assert.throws(() => reserveCustodianSpend({ custodianPath: join(dir, "cust.json"), lamports: 500 }),
    /custodian_spend_cap_exceeded/);
  // the refused call must NOT have charged anything (reserve-before-sign law)
  assert.equal(JSON.parse(readFileSync(join(dir, "spend.json"), "utf8")).spent_lamports, 600);
});

await gate("fill exactly to the cap succeeds (boundary inclusive), +1 refuses", () => {
  const r = reserveCustodianSpend({ custodianPath: join(dir, "cust.json"), lamports: 400 });
  assert.equal(r.spent_lamports, 1000);
  assert.throws(() => reserveCustodianSpend({ custodianPath: join(dir, "cust.json"), lamports: 1 }),
    /custodian_spend_cap_exceeded: era .* spent 1000 \+ wanted 1 > cap 1000/);
});

await gate("non-default custodian key file is exempt (operator-managed)", () => {
  const r = reserveCustodianSpend({ custodianPath: join(dir, "friend.json"), lamports: 999 });
  assert.equal(r, null); // never even entered the cap lane
  assert.equal(JSON.parse(readFileSync(join(dir, "spend.json"), "utf8")).spent_lamports, 1000);
});

await gate("no explicit path ⇒ the default custodian is capped", () => {
  process.env.SOLANA_CUSTODIAN_ERA = "2099-01-01"; // fresh era, clean counter
  const r = reserveCustodianSpend({ lamports: 5 });
  assert.equal(r.spent_lamports, 5);
});

await gate("era change resets the counter (fail-closed fresh era)", () => {
  process.env.SOLANA_CUSTODIAN_ERA = "2099-01-02";
  const r = reserveCustodianSpend({ custodianPath: join(dir, "cust.json"), lamports: 250 });
  assert.equal(r.era, "2099-01-02");
  assert.equal(r.spent_lamports, 250); // NOT 1255 — the new era started clean
  assert.equal(JSON.parse(readFileSync(join(dir, "spend.json"), "utf8")).era, "2099-01-02");
});

await gate("receipts ledger contains only sums (no key material)", () => {
  const row = JSON.parse(readFileSync(join(dir, "spend.json"), "utf8"));
  assert.ok(Array.isArray(row.receipts) && row.receipts.length >= 1);
  for (const s of Object.keys(JSON.parse(readFileSync(join(dir, "spend.json"), "utf8")))) {
    assert.ok(!/seed|secret|priv/i.test(s), `state file key "${s}" must never be key-like`);
  }
});

await gate("solanaPayout reserves BEFORE loadKeypair (cap refusal beats bad path)", () => {
  // Tiny remaining headroom + a bogus custodian path: if the guard is wired
  // first, the refusal is the CAP one — loadKeypair would throw a file error.
  // (The refusal is an async rejection: the guard runs before any await.)
  process.env.SOLANA_CUSTODIAN_MAX_SPEND_ERA = "1000";
  return assert.rejects(
    solanaPayout({ custodianPath: join(dir, "cust.json"), toPubkey: "11111111111111111111111111111111", lamports: 99_999, memo: "no-send" }),
    /custodian_spend_cap_exceeded/);
});

await gate("existing export surface unchanged (vendor consumers keep working)", () => {
  for (const name of ["b58encode", "b58decode", "loadKeypair", "signSolanaTx", "sendAndConfirmSolanaTx",
    "solanaBlockhash", "solanaPayout", "buildTransferCheckedIx", "buildMemoV2Ix",
    "tokenAccountAmount", "mintDecimals", "sigStatus", "solanaRpc", "RAIL", "DEFAULT_SPEND_CAP"]) {
    assert.ok(vendor[name] !== undefined, `missing export: ${name}`);
  }
});

await gate("garbage/missing state file starts a fresh era, not a wedge", () => {
  process.env.SOLANA_CUSTODIAN_SPEND_FILE = join(dir, "missing.json");
  const r = reserveCustodianSpend({ custodianPath: join(dir, "cust.json"), lamports: 10 });
  assert.equal(r.spent_lamports, 10);
  process.env.SOLANA_CUSTODIAN_SPEND_FILE = join(dir, "garbage.json");
  writeFileSync(join(dir, "garbage.json"), "{not json");
  const r2 = reserveCustodianSpend({ custodianPath: join(dir, "cust.json"), lamports: 5 });
  assert.equal(r2.spent_lamports, 5);
});

for (const k of ["SOLANA_CUSTODIAN_KEY_FILE", "SOLANA_CUSTODIAN_SPEND_FILE", "SOLANA_CUSTODIAN_MAX_SPEND_ERA", "SOLANA_CUSTODIAN_ERA"]) delete process.env[k];
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail.length} failed`);
if (fail.length) { console.log(fail.join("\n")); process.exit(1); }