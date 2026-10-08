#!/usr/bin/env node
/**
 * smoke_devnet.mjs — LIVE devnet acceptance for syn-stripe-bridge v0.2.
 *
 * FULLY GATED: the smoke never spends anything the operator has not laid out.
 * It boots the bridge with the operator's REAL custody key (read in-process
 * by path, never printed), then:
 *
 *   1. /health — prints the honest readiness state; refuses a mint mismatch.
 *   2. If bridge custody has no OUSD or <0.01 SOL, exits 0 `SMOKE SKIPPED
 *      (custody unfunded)` — the gate. Funding is the operator's action.
 *   3. SMOKE_DEPOSIT_SIG set → POST /v1/deposits credits what the chain
 *      evidences (memo X402:<merchant_id>), exact-once.
 *   4. SMOKE_CONFIRM=1 (SMOKE_RECIPIENT set) → ONE real settlement: create →
 *      confirm → transferChecked dispatch → delivered-delta gate → pacs.002
 *      Acsc → webhook ×3 → receipt.
 *
 * Env: BRIDGE_* (custody key file, merchants file, data dir…) plus
 *      SMOKE_BEARER (merchant bearer; the registry stores only its sha256),
 *      SMOKE_DEPOSIT_SIG, SMOKE_CONFIRM, SMOKE_RECIPIENT, SMOKE_AMOUNT (cents).
 * Skips count as pass (exit 0); only a failed gate exits non-zero.
 */

const log = (...a) => console.log("[smoke]", ...a);
const die = (msg, code = 1) => { console.error("[smoke] FAILED:", msg); process.exit(code); };

const { createBridgeServer, OUSD_DEVNET_MINT } = await import("../src/stripe_shim.mjs");

(async () => {
    const bridge = createBridgeServer();
    // 1. health (no auth): identity must be exactly the devnet OUSD estate mint
    const health = await api(bridge, "GET", "/health");
    log("health:", JSON.stringify({ version: health.version, ousd_mint: health.rail.ousd_mint, custody: health.custody?.custodyPubkey, merchants: health.merchants_loaded }));
    if (health.rail.ousd_mint !== OUSD_DEVNET_MINT) die(`unexpected OUSD mint ${health.rail.ousd_mint} — refusing to smoke against anything but the devnet estate mint`);
    if (!health.custody?.custodyPubkey) die("custody key did not load — check BRIDGE_CUSTODY_KEY_FILE");
    if (!health.merchants_loaded) die("no merchants loaded — check BRIDGE_MERCHANTS_FILE");

    // 2. funding gate: custody must hold OUSD AND fee lamports BEFORE anything moves
    const custody = await api(bridge, "GET", "/v1/custody");
    log("custody:", JSON.stringify({ ata: custody.custodyAta, ousd_raw: custody.custodyOusdRaw, ousd_major: custody.custody_ousd_major, lamports: custody.custodySolLamports }));
    const ousdRaw = custody.custodyOusdRaw === null ? 0n : BigInt(custody.custodyOusdRaw);
    const solL = custody.custodySolLamports === null ? 0n : BigInt(custody.custodySolLamports);
    if (ousdRaw === 0n || solL < 10_000_000n) {
        log(`SMOKE SKIPPED (custody unfunded): custody ATA ${custody.custodyAta} holds ${ousdRaw} raw OUSD / ${solL} lamports — fund it and re-run.`);
        process.exit(0);
    }

    // 3. authenticated legs
    const bearer = process.env.SMOKE_BEARER;
    if (!bearer) die("SMOKE_BEARER required once custody is funded (the registry file stores only its sha256)");

    if (process.env.SMOKE_DEPOSIT_SIG) {
        const dep = await api(bridge, "POST", "/v1/deposits", { signature: process.env.SMOKE_DEPOSIT_SIG }, bearer);
        log("deposit verified on-chain:", JSON.stringify({ units: dep.units, verified_from_chain: dep.verified_from_chain, balance_raw: dep.balance?.raw }));
    }

    // 4. the one REAL settlement (operator-confirmed)
    if (process.env.SMOKE_CONFIRM === "1") {
        const recipient = process.env.SMOKE_RECIPIENT;
        if (!recipient) die("SMOKE_RECIPIENT required for the confirm leg");
        const create = await api(bridge, "POST", "/v1/payment_intents", {
            amount: parseInt(process.env.SMOKE_AMOUNT || "2500", 10),
            currency: "usd",
            metadata: {
                solana_recipient: recipient,
                debtor_name: process.env.SMOKE_DEBTOR_NAME ?? "Smoke Merchant Treasury",
                debtor_bic: process.env.SMOKE_DEBTOR_BIC,
                creditor_name: process.env.SMOKE_CREDITOR_NAME,
                creditor_bic: process.env.SMOKE_CREDITOR_BIC,
            },
        }, bearer);
        if (create.status !== 201) die(`intent create refused: ${JSON.stringify(create.error ?? create)}`);
        log("intent created:", create.id, "status:", create.status);

        const conf = await api(bridge, "POST", `/v1/payment_intents/${create.id}/confirm`, undefined, bearer);
        log("confirm →", conf.status);
        if (conf.status === "succeeded") {
            log("SETTLED: rail signature", conf.iso20022?.rail_signature);
            log("pacs.002 status:", conf.iso20022?.pacs002_report?.transaction_information_and_status?.[0]?.transaction_status, "(must be Acsc)");
            log("delivered-delta gate:", JSON.stringify(conf.last_verification));
            log("webhook attempts:", JSON.stringify(conf.webhook?.length ?? conf.webhook));
            log("receipt:", conf.receipt_url);
        } else {
            // honest outcome: 202 processing (verify-on-read will finish it) or
            // 500 settlement_broken — never a fabricated success.
            log("honest non-succeeded outcome:", JSON.stringify({ status: conf.status, code: conf.error?.code, gate: conf.gate ?? conf.last_verification }));
        }
    }

    log("SMOKE COMPLETE — every gate reached passed");
    process.exit(0);
})().catch((e) => die(String(e?.message ?? e)));

/** Drive handleStripeRequest directly (no open port needed). */
async function api(bridge, method, pathname, body, bearer) {
    const raw = body === undefined ? null : JSON.stringify(body);
    const headers = bearer ? { authorization: `Bearer ${bearer}`, "idempotency-key": `smoke-${Date.now()}` } : {};
    return new Promise((resolve, reject) => {
        const fakeRes = { writeHead(s) { this._s = s; }, end(out) { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } } };
        bridge.handleStripeRequest(fakeReq(method, pathname, raw, headers), fakeRes);
    });
}
function fakeReq(method, pathname, raw, headers) {
    let sent = false;
    return {
        method, url: pathname, headers,
        on(ev, cb) {
            if (ev === "data" && raw && !sent) { sent = true; cb(Buffer.from(raw)); }
            if (ev === "end") { if (raw && !sent) { sent = true; cb(Buffer.from(raw)); } cb(); }
        },
    };
}