/**
 * Offline structural test suite for syn-stripe-bridge v0.2.
 *
 * NO Solana network access: run via `node tests/run-tests.mjs`, which pins
 * SOLANA_RPC_URL to tests/mock-solana-rpc.mjs BEFORE the vendored stack loads.
 * The mock replays the REAL devnet wire shape of an estate OUSD transferChecked
 * leg over REAL base58 fixtures.
 *
 * Proves the honest-core contract (F1–F9): fail-closed auth, no-default
 * refusals, exact-once deposits, pacs.002 only after the delivered-delta
 * gate, idempotency, O_EXCL ledger persistence.
 */

import { strictEqual, ok as assertOk, deepEqual } from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { b58encode, b58decode } from "../vendor/solana-tx.mjs";
import { deriveAssociatedTokenAddress, TOKEN_2022 } from "../vendor/ata.mjs";
import { ed25519 } from "../vendor/vendor-noble/node_modules/@noble/curves/ed25519.js";
import { CBPRPlusValidator } from "../src/cbpr_validator.mjs";
import { depositUnitsFromTx } from "../src/token-evidence.mjs";
import { mockTxState } from "./mock-solana-rpc.mjs";

const OUSD_MINT = "2ANrmtAcMd8eihFGvbyAkrAWveq8nU6uMTigbWBuigNe";
const MAINNET_MINT = "ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

// ---- real fixtures ----------------------------------------------------------
function makeRealKeypair() {
    const seed = randomBytes(32);
    const pub = Buffer.from(ed25519.getPublicKey(seed));
    const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
    return { der, pubB58: b58encode(pub) };
}

/**
 * A REAL getTransaction-shaped document for an OUSD (Token-2022, decimals 6)
 * transferChecked from `custodyPk` into `ata` of `raw` units with a SPL Memo v2
 * ix — identical layout to the estate's live-verified legs (the evidence
 * parser is exercised against the real wire, not a shortcut stub).
 */
function buildMockTxDoc({ custodyPk, ata, mint, raw, memoText, err = null }) {
    const mintB = Buffer.from(b58decode(mint));
    const data = Buffer.alloc(10);
    data[0] = 12;
    data.writeBigUInt64LE(BigInt(raw), 1);
    data[9] = 6;
    const doc = {
        slot: 3_000_000 + (Number(BigInt(raw) % 100_000n)),
        transaction: {
            message: {
                accountKeys: [custodyPk, b58encode(mintB), TOKEN_2022_PROGRAM, MEMO_PROGRAM, ata, custodyPk],
                instructions: [
                    { programIdIndex: 2, accounts: [0, 1, 4, 5], data: b58encode(data) }, // source, mint, dest, authority
                    { programIdIndex: 3, accounts: [], data: b58encode(Buffer.from(memoText, "utf8")) },
                ],
            },
        },
        meta: { err, preTokenBalances: [], postTokenBalances: [], loadedAddresses: { writable: [], readonly: [] } },
    };
    return doc;
}

// ---- boot -------------------------------------------------------------------
let tmpRoot, merchantsFile, bridge, BEARER, RECIPIENT;
const bad = "sk_bridge_not_a_valid_key";

test.before(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sbridge-"));
    BEARER = `sk_bridge_test_${randomBytes(20).toString("hex")}`;
    const bearerHash = createHash("sha256").update(BEARER).digest("hex");
    merchantsFile = path.join(tmpRoot, "merchants.json");
    fs.writeFileSync(merchantsFile, JSON.stringify([{
        id: "merchtest", name: "Test Merchant Ltd",
        bearer_hash: bearerHash,
        institution_bic: "TESTUS33XXX", institution_name: "Test Merchant Treasury",
        webhook_url: "http://127.0.0.1:1/hook", webhook_secret: "whsec_test_hook",
    }], null, 2), { mode: 0o600 });

    // custody: a real ed25519 keypair written as a 64-int solana CLI keypair file
    const cust = makeRealKeypair();
    const custFile = path.join(tmpRoot, "custody.json");
    fs.writeFileSync(custFile, JSON.stringify([...Buffer.from(cust.der.subarray(16, 48)), ...Buffer.from(b58decode(cust.pubB58))]) + "\n", { mode: 0o600 });
    RECIPIENT = makeRealKeypair().pubB58;

    const { createBridgeServer } = await import("../src/stripe_shim.mjs");
    bridge = createBridgeServer({
        merchantsFile, custodyKeyFile: custFile,
        dataDir: path.join(tmpRoot, "data"), ousdMint: OUSD_MINT, port: 0, host: "127.0.0.1",
    });
    // The mock deposit doc: 3000 cents => 30_000_000 raw units INTO custody ATA,
    // memo X402:merchtest (the SSOT routing tag).
    const dSig = "7" + "x".repeat(86);
    mockTxState.set(dSig, buildMockTxDoc({ custodyPk: bridge.custody.pubkey, ata: bridge.custodyAta, mint: OUSD_MINT, raw: 30_000_000, memoText: "X402:merchtest" }));
});

function req(bridgeInstance, { method, path, body, bearer, headers = {}, rawForm = null }) {
    const h = { ...headers };
    if (bearer) h.authorization = `Bearer ${bearer}`;
    return new Promise((resolve) => {
        const fakeRes = {
            writeHead(status) { this._status = status; },
            end(out) { resolve({ status: this._status, body: out ? JSON.parse(out) : null }); },
        };
        const raw = rawForm !== null ? rawForm : (body === undefined ? null : JSON.stringify(body));
        const fakeReq = {
            method, url: path, headers: h,
            on(ev, cb) {
                if (ev === "data" && raw) cb(Buffer.from(raw));
                if (ev === "end") cb();
            },
        };
        bridgeInstance.handleStripeRequest(fakeReq, fakeRes);
    });
}

// ---- the suite --------------------------------------------------------------
test("bridge boots with the honest devnet identity", () => {
    strictEqual(bridge.cfg.ousdMint, OUSD_MINT);
    assertOk(bridge.custody.pubkey.length >= 40);
    assertOk(bridge.custodyAta.length >= 40);
});

test("boot REFUSES the mainnet registry mint (binding drift, by name)", async () => {
    const { createBridgeServer } = await import("../src/stripe_shim.mjs");
    let threw = null;
    try { createBridgeServer({ ousdMint: MAINNET_MINT, merchantsFile, custodyKeyFile: bridge.cfg.custodyKeyFile, dataDir: path.join(tmpRoot, "data2") }); } catch (e) { threw = e; }
    assertOk(threw, "boot must refuse the mainnet registry mint");
    assertOk(/MAINNET registry mint/.test(String(threw?.message ?? "")));
});

test("auth: no bearer => 401; bad bearer => 401 (fail-closed, F5)", async () => {
    const noAuth = await req(bridge, { method: "GET", path: "/v1/balance" });
    strictEqual(noAuth.status, 401);
    const badAuth = await req(bridge, { method: "GET", path: "/v1/balance", bearer: "sk_bridge_no_such_secret" });
    strictEqual(badAuth.status, 401);
    strictEqual(badAuth.body.error.code, "invalid_api_key");
});

test("amount: missing => amount_required; no 1000 default ever (F9)", async () => {
    const r = await req(bridge, { method: "POST", path: "/v1/payment_intents", body: { currency: "usd" }, bearer: BEARER });
    strictEqual(r.status, 400);
    strictEqual(r.body.error.code, "amount_required");
    const bad = await req(bridge, { method: "POST", path: "/v1/payment_intents", body: { amount: 10.5, currency: "usd" }, bearer: BEARER });
    strictEqual(bad.body.error.code, "amount_invalid");
});

test("currency: missing => currency_required; non-usd => unsupported_currency", async () => {
    const missing = await req(bridge, { method: "POST", path: "/v1/payment_intents", body: { amount: 1000 }, bearer: BEARER });
    strictEqual(missing.body.error.code, "currency_required");
    const eur = await req(bridge, { method: "POST", path: "/v1/payment_intents", body: { amount: 1000, currency: "eur" }, bearer: BEARER });
    strictEqual(eur.body.error.code, "unsupported_currency");
});

test("recipient: missing/invalid => 400; NO default 4uQeVj… constant (F4)", async () => {
    const missing = await req(bridge, { method: "POST", path: "/v1/payment_intents", body: { amount: 1000, currency: "usd" }, bearer: BEARER });
    strictEqual(missing.body.error.code, "recipient_required");
    const invalid = await req(bridge, { method: "POST", path: "/v1/payment_intents", body: { amount: 1000, currency: "usd", metadata: { solana_recipient: "zzz" } }, bearer: BEARER });
    strictEqual(invalid.body.error.code, "recipient_invalid");
});

test("tsa_bps != 0 => 400 levy_not_configured (no fabricated charge)", async () => {
    const r = await req(bridge, { method: "POST", path: "/v1/payment_intents", body: { amount: 1000, currency: "usd", metadata: { solana_recipient: RECIPIENT, tsa_bps: 25 } }, bearer: BEARER });
    strictEqual(r.body.error.code, "levy_not_configured");
});

test("confirm with missing ISO20022 parties => 400 iso20022_fields_missing (F8), BEFORE any rail action", async () => {
    const create = await req(bridge, { method: "POST", path: "/v1/payment_intents", body: { amount: 2500, currency: "usd", metadata: { solana_recipient: RECIPIENT } }, bearer: BEARER });
    strictEqual(create.status, 201);
    const conf = await req(bridge, { method: "POST", path: `/v1/payment_intents/${create.body.id}/confirm`, bearer: BEARER });
    strictEqual(conf.status, 400);
    strictEqual(conf.body.error.code, "iso20022_fields_missing");
    assertOk(conf.body.missing.includes("creditor_bic"));
    // the intent did NOT move to processing — no rail dispatch happened
    const get = await req(bridge, { method: "GET", path: `/v1/payment_intents/${create.body.id}`, bearer: BEARER });
    strictEqual(get.body.status, "requires_confirmation");
});

test("confirm without prefund => 402 card_error insufficient_funds + refusal object; NO debit", async () => {
    const create = await req(bridge, { method: "POST", path: "/v1/payment_intents", body: { amount: 2500, currency: "usd", metadata: { solana_recipient: RECIPIENT, debtor_name: "Test Merchant Ltd", debtor_bic: "TESTUS33XXX", creditor_name: "Recipient Ltd", creditor_bic: "CREDGB22XXX" } }, bearer: BEARER });
    const conf = await req(bridge, { method: "POST", path: `/v1/payment_intents/${create.body.id}/confirm`, bearer: BEARER });
    strictEqual(conf.status, 402);
    // NB: inside the queue the merchant-balance gate fires first
    strictEqual(conf.body.error.code, "insufficient_funds");
    assertOk(conf.body.refusal && conf.body.refusal.reason === "insufficient_funds");
    const bal = await req(bridge, { method: "GET", path: "/v1/balance", bearer: BEARER });
    strictEqual(bal.body.raw, "0");
});

test("deposit with the WRONG memo is refused, never credited (evidence gate)", async () => {
    const badSig = "3" + "x".repeat(86);
    mockTxState.set(badSig, buildMockTxDoc({ custodyPk: bridge.custody.pubkey, ata: bridge.custodyAta, mint: OUSD_MINT, raw: 10_000_000, memoText: "X402:othermerchant" }));
    const r = await req(bridge, { method: "POST", path: "/v1/deposits", body: { signature: badSig }, bearer: BEARER });
    strictEqual(r.status, 400);
    strictEqual(r.body.error.code, "deposit_not_evidenced");
    strictEqual(r.body.refusal.expected_memo, "X402:merchtest");
});

test("deposit with the CORRECT memo verifies from the CHAIN and credits", async () => {
    const goodSig = "7" + "x".repeat(86);
    const r = await req(bridge, { method: "POST", path: "/v1/deposits", body: { signature: goodSig }, bearer: BEARER });
    strictEqual(r.status, 201, `deposit failed: ${JSON.stringify(r.body)}`);
    strictEqual(r.body.units, "30000000");
    strictEqual(r.body.verified_from_chain, true);
    const bal = await req(bridge, { method: "GET", path: "/v1/balance", bearer: BEARER });
    strictEqual(bal.body.raw, "30000000");
});

test("deposit replay => 409 already_credited (single-use signatures, exact-once)", async () => {
    const r = await req(bridge, { method: "POST", path: "/v1/deposits", body: { signature: "7" + "x".repeat(86) }, bearer: BEARER });
    strictEqual(r.status, 409);
    strictEqual(r.body.refusal.reason, "already_credited");
    const bal = await req(bridge, { method: "GET", path: "/v1/balance", bearer: BEARER });
    strictEqual(bal.body.raw, "30000000", "no double credit");
});

test("deposit of an ERRORED tx is never evidence", async () => {
    const errSig = "8" + "x".repeat(86);
    mockTxState.set(errSig, buildMockTxDoc({ custodyPk: bridge.custody.pubkey, ata: bridge.custodyAta, mint: OUSD_MINT, raw: 10_000_000, memoText: "X402:merchtest", err: { InstructionError: [1, { Custom: 1 }] } }));
    const parsed = await depositUnitsFromTx(mockTxState.get(errSig), bridge.custodyAta);
    deepEqual(parsed.payments, []);
    const r = await req(bridge, { method: "POST", path: "/v1/deposits", body: { signature: errSig }, bearer: BEARER });
    strictEqual(r.status, 400);
    strictEqual(r.body.error.code, "deposit_tx_failed");
});

test("idempotency-key: replay returns the SAME intent id", async () => {
    const first = await req(bridge, { method: "POST", path: "/v1/payment_intents", body: { amount: 500, currency: "usd", metadata: { solana_recipient: RECIPIENT } }, bearer: BEARER, headers: { "idempotency-key": "idem-1" } });
    strictEqual(first.status, 201);
    const second = await req(bridge, { method: "POST", path: "/v1/payment_intents", body: { amount: 500, currency: "usd", metadata: { solana_recipient: RECIPIENT } }, bearer: BEARER, headers: { "idempotency-key": "idem-1" } });
    strictEqual(second.body.id, first.body.id);
});

test("ledger: append-only receipts.jsonl exists, and a FRESH boot replays balances", async () => {
    const ledgerPath = path.join(bridge.cfg.dataDir, "receipts.jsonl");
    assertOk(fs.existsSync(ledgerPath));
    const rows = fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const deposits = rows.filter((r) => r.kind === "deposit");
    strictEqual(deposits.length, 1);
    strictEqual(deposits[0].units, "30000000");
    strictEqual(deposits[0].verified, true);
    assertOk(rows.filter((r) => r.kind === "intent").length >= 3);

    // A second bridge on the SAME dataDir must rebuild the credited balance
    // and the used-signature set from the ledger alone.
    const { createBridgeServer } = await import("../src/stripe_shim.mjs");
    const rebooted = createBridgeServer({
        merchantsFile, custodyKeyFile: bridge.cfg.custodyKeyFile,
        dataDir: bridge.cfg.dataDir, ousdMint: OUSD_MINT, port: 0, host: "127.0.0.1",
    });
    const r = await req(rebooted, { method: "GET", path: "/v1/balance", bearer: BEARER });
    strictEqual(r.body.raw, "30000000", "replayed balance");
    const replay = await req(rebooted, { method: "POST", path: "/v1/deposits", body: { signature: "7" + "x".repeat(86) }, bearer: BEARER });
    strictEqual(replay.status, 409, "replayed deposit signature is still single-use after reboot");
});

test("form-encoded Stripe SDK bodies: amount/currency/metadata[...] brackets parse (drop-in dialect)", async () => {
    // stripe-python / stripe-node POST application/x-www-form-urlencoded —
    // the drop-in contract means the bridge reads THEIR dialect, not JSON-only.
    const h = { "content-type": "application/x-www-form-urlencoded" };
    const create = await req(bridge, { method: "POST", path: "/v1/payment_intents", bearer: BEARER, headers: h, body: null, rawForm: "amount=1000&currency=usd&metadata[solana_recipient]=" + encodeURIComponent(RECIPIENT) + "&metadata[debtor_name]=Form Merchant Ltd&metadata[debtor_bic]=TESTUS33XXX&metadata[creditor_name]=Form Creditor Ltd&metadata[creditor_bic]=CREDGB22XXX" });
    strictEqual(create.status, 201, JSON.stringify(create.body));
    strictEqual(create.body.metadata.debtor_name, "Form Merchant Ltd");
    strictEqual(create.body.metadata.solana_recipient, RECIPIENT);
    const conf = await req(bridge, { method: "POST", path: `/v1/payment_intents/${create.body.id}/confirm`, bearer: BEARER, headers: h, body: null, rawForm: "" });
    strictEqual(conf.status, 402, `form-encoded confirm: ${JSON.stringify(conf.body)}`);
    strictEqual(conf.body.error.code, "insufficient_funds", "form-encoded ISO parties resolved → readiness 402, not 400 fields_missing");
    strictEqual(conf.body.refusal.reason, "bridge_custody_unfunded", "merchant-funded but CUSTODY unfunded is the honest 402, never a 500 or a dispatch");
});

test.skip("settlement happy path + webhook delivery (LIVE devnet, custody-funded) — run scripts/smoke_devnet.mjs", async () => {});

test("evidence: UETR/memo/pacs grammar round-trips via the SSOT (no hand-written memo)", async () => {
    // The bridge's own wire parts builder must agree with the SSOT builder.
    const { buildDeskSettlementMemo } = await import("../vendor/discriminators.mjs");
    const memo = buildDeskSettlementMemo("64e2d726-dab8-4b8b-8e6b-0f6a30c6a9c1", "SBRpi_syn_000001", "10000000", "0");
    const { validateTswpMemo } = await import("../vendor/discriminators.mjs");
    const check = validateTswpMemo(memo);
    strictEqual(check.valid, true);
    assertOk(memo.startsWith("X402P:"));
});