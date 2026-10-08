/**
 * SynapticChain Stripe Bridge v0.2 — honest settlement core.
 *
 * v0.1's promise ("Drop-in Stripe → real OUSD settlement") was true only in
 * its README; its core fabricated everything (F1–F9, bridging review
 * 2026-10-08). v0.2 keeps the Stripe-shaped API surface and replaces the core
 * with the estate's live-proven rails, so every response is earned:
 *
 *   - REAL custody: the bridge operator pre-funds a Solana custody keypair
 *     (BRIDGE_CUSTODY_KEY_FILE, read in-process BY PATH, never printed/returned)
 *     holding devnet OUSD (Token-2022). No ephemeral boot keypair (F4), no
 *     default recipient, no fabricated fx (F3): 1 Stripe minor unit (cent)
 *     credits to exactly 10_000 raw OUSD base units on the devnet mint.
 *   - REAL wire stack: the vendored estate handrolled-solana stack (web3.js is
 *     banned from app paths) + ata.mjs + the x402-TSWP SSOT memo grammar
 *     (X402P settlement frame via buildDeskSettlementMemo, tsa_bps = 0).
 *   - REAL auth: fail-closed bearer registry (sha256, timing-safe). A request
 *     with no/unknown credentials is a 401 — never a happy default (F5).
 *   - REAL evidence: settlement status `succeeded` ONLY after the delivered-
 *     delta gate — getTransaction of the confirmed signature must show a
 *     transferChecked of exactly the intended raw units into the recipient's
 *     ATA on the configured mint, and the destination balance is re-read.
 *     (F1's unconditional Acsc is gone.) pacs.002 (Acsc) is emitted only after
 *     that gate and carries the real rail signature + slot.
 *   - REAL preflight (F6): merchant prepaid balance, custody OUSD + SOL
 *     readiness, ISO 20022 party fields — every refusal verbatim, no defaults.
 *   - REAL webhook (F7): Stripe-shaped `payment_intent.succeeded` actually
 *     POSTed with HMAC `t=<unix>,v1=<hex>` ×3 attempts (attempts recorded).
 *   - REAL persistence (F9): append-only `data/receipts.jsonl` (create-only,
 *     never rewritten), replayed on boot; receipt_url only from a real
 *     confirmed signature.
 *
 * Zero custody law: keys are read in-process by path; nothing is printed.
 */

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    loadKeypair,
    solanaBlockhash,
    signSolanaTx,
    sendAndConfirmSolanaTx,
    buildTransferCheckedIx,
    buildMemoV2Ix,
    tokenAccountAmount,
    mintDecimals,
    RAIL,
} from "../vendor/solana-tx.mjs";
import {
    setComputeUnitLimitData,
    createIdempotentData,
    createIdempotentAccounts,
    deriveAssociatedTokenAddress,
    ATA_PROGRAM,
    TOKEN_2022,
} from "../vendor/ata.mjs";
import { solanaRpc } from "../vendor/solana-tx.mjs";
import { buildDeskSettlementMemo, validateTswpMemo, buildCorridorMemo } from "../vendor/discriminators.mjs";
import { CBPRPlusValidator } from "./cbpr_validator.mjs";
import { depositUnitsFromTx, getSettledTx } from "./token-evidence.mjs";

const BRIDGE_VERSION = "0.2.0";

// Ground truth pinned 2026-10-08 (estate OUSD estate devnet):
// mainnet registry mint is REFUSED by name — binding it to this bridge's devnet
// custody would be a binding-drift lie.
export const OUSD_DEVNET_MINT = "2ANrmtAcMd8eihFGvbyAkrAWveq8nU6uMTigbWBuigNe";
export const OUSD_WIRE_DECIMALS = 6;
export const OUSD_MAINNET_REGISTRY_MINT = "ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB";
const RAW_UNITS_PER_CENT = BigInt(10_000); // 1 cent => 1e-4 OUSD on a 6-decimal mint (1 OUSD = $1)
const CUSTODY_SOL_BUFFER = BigInt(10_000_000); // rent for a fresh recipient ATA + fees, lamports
const CUSTODY_SOL_FEE_ONLY = BigInt(10_000);   // fees only when the destination ATA exists
const CONFIRM_MS = 15_000; // Operator 15s law: over-budget confirmations drop to "processing"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class Refusal extends Error {
    constructor(httpStatus, body, refusal) {
        super(body.message ?? body.error);
        this.httpStatus = httpStatus;
        this.body = body;
        this.refusal = refusal;
    }
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ---------------- merchant registry (0600, hash-only) -----------------------
function loadMerchants(filePath) {
    if (!filePath) throw new Error("bridge_boot_refused: BRIDGE_MERCHANTS_FILE is required — no default merchant ever exists");
    const st = fs.statSync(filePath);
    // Strict mode check: file mode must be 0600-or-stricter (no group/other bits).
    if (st.mode & 0o077) {
        throw new Error(`bridge_boot_refused: merchant registry ${filePath} must be 0600 (got mode ${(st.mode & 0o777).toString(8)})`);
    }
    const rows = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error(`bridge_boot_refused: ${filePath} must be a non-empty array of merchant records`);
    }
    const byId = new Map();
    const byHash = new Map();
    for (const m of rows) {
        const id = String(m?.id ?? "");
        const bearerHash = String(m?.bearer_hash ?? "");
        // Merchant IDs must satisfy the SSOT corridor grammar — the deposit
        // routing memo `X402:<id>` is built and validated with the SSOT builder.
        let corridorMemoOk = false;
        try { validateTswpMemo(buildCorridorMemo(id)); corridorMemoOk = true; } catch { corridorMemoOk = false; }
        if (!id || !corridorMemoOk) {
            throw new Error(`bridge_boot_refused: merchant id invalid for SSOT X402 memo grammar: "${id.slice(0, 40)}"`);
        }
        if (!/^[0-9a-f]{64}$/.test(bearerHash)) {
            throw new Error(`bridge_boot_refused: merchant '${id}' bearer_hash must be a sha256 hex digest`);
        }
        if (byId.has(id)) throw new Error(`bridge_boot_refused: duplicate merchant id '${id}'`);
        const rec = {
            id,
            name: String(m?.name ?? id),
            bearerHash,
            institutionBic: m?.institution_bic ?? null,
            institutionName: m?.institution_name ?? m?.name ?? null,
            webhookUrl: m?.webhook_url ?? null,
            webhookSecret: m?.webhook_secret ?? null,
        };
        if (rec.institutionBic && !/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(rec.institutionBic)) {
            throw new Error(`bridge_boot_refused: merchant '${id}' institution_bic is not an ISO 9362 BIC`);
        }
        byId.set(id, rec);
        byHash.set(bearerHash, id);
    }
    return { byId, byHash, rawPath: filePath };
}

// ---------------- append-only ledger (O_EXCL create, replay on boot) --------
function openLedgerAppendOnly(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    const ledgerPath = path.join(dataDir, "receipts.jsonl");
    if (!fs.existsSync(ledgerPath)) {
        const fd = fs.openSync(ledgerPath, "wx", 0o600); // O_EXCL: never clobber an existing ledger
        fs.closeSync(fd);
    }
    return ledgerPath;
}

function replayLedger(ledgerPath) {
    const state = { balances: new Map(), intents: new Map(), depositSigners: new Set(), idempotency: new Map() };
    if (!fs.existsSync(ledgerPath)) return state;
    const lines = fs.readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.trim());
    for (const line of lines) {
        let row;
        try { row = JSON.parse(line); } catch { continue; } // trailing torn line after a crash — skipped, never silently credited
        if (row.kind === "deposit" && row.verified) {
            state.balances.set(row.merchant, (state.balances.get(row.merchant) ?? 0n) + BigInt(row.units));
            state.depositSigners.add(row.signature);
        } else if (row.kind === "intent") {
            state.intents.set(row.intent.id, row.intent);
            if (row.intent.idempotencyKey && row.intent.idempotencyResponse) {
                state.idempotency.set(`${row.intent.merchant}:${row.intent.idempotencyKey}`, row.intent.idempotencyResponse);
            }
        } else if (row.kind === "settlement" && row.status === "succeeded") {
            state.balances.set(row.merchant, (state.balances.get(row.merchant) ?? 0n) - BigInt(row.units));
        } else if (row.kind === "settlement" && row.status === "reversed") {
            state.balances.set(row.merchant, (state.balances.get(row.merchant) ?? 0n) + BigInt(row.units));
        }
    }
    return state;
}

// ---------------- settlement queue (one dispatch at a time) -----------------
function createSettlementQueue() {
    let tail = Promise.resolve();
    return (fn) => {
        const run = tail.then(fn, fn);
        tail = run.then(() => undefined, () => undefined);
        return run;
    };
}

// ---------------- the bridge -----------------------------------------------
export function createBridgeServer(opts = {}) {
    const cfg = {
        custodyKeyFile: opts.custodyKeyFile ?? process.env.BRIDGE_CUSTODY_KEY_FILE,
        ousdMint: opts.ousdMint ?? process.env.BRIDGE_OUSD_MINT ?? OUSD_DEVNET_MINT,
        dataDir: opts.dataDir ?? process.env.BRIDGE_DATA_DIR ?? path.join(repoRoot, "data"),
        merchantsFile: opts.merchantsFile ?? process.env.BRIDGE_MERCHANTS_FILE,
        port: opts.port ?? parseInt(process.env.STRIPE_SHIM_PORT || "8092", 10),
        host: opts.host ?? process.env.STRIPE_SHIM_HOST ?? "127.0.0.1",
    };
    if (cfg.ousdMint === OUSD_MAINNET_REGISTRY_MINT) {
        throw new Error(`bridge_boot_refused: BRIDGE_OUSD_MINT names the MAINNET registry mint — binding drift is refused; the bridge settles the estate-devnet OUSD mint ${OUSD_DEVNET_MINT}`);
    }

    const merchants = loadMerchants(cfg.merchantsFile);
    if (!cfg.custodyKeyFile) {
        throw new Error("bridge_boot_refused: BRIDGE_CUSTODY_KEY_FILE is required — the bridge never fabricates or boot-generates custody keys");
    }
    // Loaded in-process by path. The private key never reappears in any
    // response, log line, or error (zero-custody law).
    const custody = loadKeypair(cfg.custodyKeyFile);
    const MINT = cfg.ousdMint;
    const custodyAta = deriveAssociatedTokenAddress(custody.pubkey, TOKEN_2022, MINT);

    const ledgerPath = openLedgerAppendOnly(cfg.dataDir);
    const replay = replayLedger(ledgerPath);
    const balances = replay.balances;               // merchantId -> BigInt raw OUSD
    const intents = replay.intents;                 // intentId -> intent object
    const depositSigners = replay.depositSigners;   // single-use deposit signatures
    const idempotency = replay.idempotency;         // merchant:key -> stored response
    const usedUetrs = new Set();
    for (const i of intents.values()) if (i.uetr) usedUetrs.add(i.uetr);

    const ledger = (row) => fs.appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    const persistIntent = (intent) => ledger({ ts: Date.now(), kind: "intent", intent: { ...intent, webhookAttempts: undefined } });
    // Webhook secrets/urls are config, never ledger material — persistIntent strips runtime fields.
    const settlementQueue = createSettlementQueue();

    const b58decode32 = (s) => {
        // Minimal correct base58 decode (same alphabet/wire convention as the
        // vendored stack): leading '1's are zero bytes, all digits valid.
        const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        const sStr = String(s ?? "");
        if (!sStr.length) return null;
        const zeros = [] ;
        for (const ch of sStr) { if (ch === "1") zeros.push(0); else break; }
        const bytes = [];
        for (const ch of sStr) {
            const idx = A.indexOf(ch);
            if (idx === -1) return null;
            let carry = idx;
            for (let i = 0; i < bytes.length; i++) {
                carry += bytes[i] * 58;
                bytes[i] = carry & 0xff;
                carry >>= 8;
            }
            while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
        }
        const full = Buffer.concat([Buffer.from(zeros), Buffer.from(bytes.reverse())]);
        return full.length === 32 ? full : null;
    };

    // ---------------- auth ----------------
    function auth(req) {
        // Fail closed: no header, unknown secret, or malformed scheme → 401.
        const header = req.headers.authorization ?? "";
        const m = /^(?:Bearer|bearer)\s+(\S+)$/.exec(header);
        if (!m) throw new Refusal(401, { error: { type: "invalid_request_error", code: "missing_api_key", message: "No API key provided (Authorization: Bearer sk_...)." } });
        const presented = sha256(m[1]);
        const bufA = Buffer.from(presented, "hex");
        for (const [hash, id] of merchants.byHash) {
            // length check first; timing-safe compare only on equal lengths
            const bufB = Buffer.from(hash, "hex");
            if (bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)) return merchants.byId.get(id);
        }
        throw new Refusal(401, { error: { type: "invalid_request_error", code: "invalid_api_key", message: "The API key provided is invalid." } });
    }

    // ---------------- rail readers ----------------
    // Solana's getBalance result is an envelope {context, value} — unwrap both
    // shapes (a bare u64 only on some nonstandard nodes); never guess.
    async function readCustodySol() {
        try {
            const j = await solanaRpc("getBalance", [custody.pubkey]);
            const r = j?.result;
            const lamports = (typeof r === "object" && r !== null) ? r.value : r;
            return (typeof lamports === "number" || typeof lamports === "string") ? BigInt(lamports) : null;
        } catch { return null; }
    }

    async function custodyReadiness() {
        const out = { custodyPubkey: custody.pubkey, custodyAta, ousdMint: MINT, decimals: OUSD_WIRE_DECIMALS };
        try { out.custodyOusdRaw = (await tokenAccountAmount(custodyAta)).toString(); } catch { out.custodyOusdRaw = null; }
        const lamports = await readCustodySol();
        out.custodySolLamports = lamports === null ? null : lamports.toString();
        return out;
    }

    async function requireDestinationBalanceReady(recipientAta, neededRaw) {
        // Destination ATA re-read for the delivered-delta gate baseline.
        try { return await tokenAccountAmount(recipientAta); } // BigInt
        catch (e) {
            if (/not found on-chain/.test(String(e?.message ?? e))) return null; // absent — CreateIdempotent will fund it
            throw new Error(`settlement_precheck_transport: destination ATA unreadable (transport class, not a refusal): ${String(e?.message ?? e).slice(0, 200)}`);
        }
    }

    // ---------------- wire construction (SSOT memo + CBPR+ pre-validated) -----
    function buildSettlementWireParts({ merchant, intent, uetr, baseUnits }) {
        const paymentId = `SBR${intent.id.replace(/[^0-9a-zA-Z._-]/g, "").slice(-30)}`; // ≤35, SSOT-safe alphabet
        const msgId = paymentId;
        const memo = buildDeskSettlementMemo(uetr, msgId, baseUnits.toString(), "0"); // X402P, tsa_bps 0 (F: no fake levy)
        return { paymentId, msgId, memo, uetr };
    }

    function iso20022Parties(merchant, intent) {
        const meta = intent.metadata ?? {};
        const debtorBic = meta.debtor_bic ?? merchant.institutionBic ?? null;
        const debtorName = meta.debtor_name ?? merchant.institutionName ?? null;
        const creditorBic = meta.creditor_bic ?? null;
        const creditorName = meta.creditor_name ?? null;
        if (!debtorBic || !debtorName || !creditorBic || !creditorName) {
            const missing = [];
            if (!debtorBic) missing.push("debtor_bic");
            if (!debtorName) missing.push("debtor_name");
            if (!creditorBic) missing.push("creditor_bic");
            if (!creditorName) missing.push("creditor_name");
            throw new Refusal(400, {
                error: { type: "invalid_request_error", code: "iso20022_fields_missing", message: `ISO 20022 party fields missing: ${missing.join(", ")}. Supply them in intent metadata or the merchant institution config — defaults would fabricate a bank.` },
                missing: missing,
            }, { reason: "iso20022_fields_missing", missing });
        }
        return { debtorName, debtorBic, creditorName, creditorBic };
    }

    async function deliveredDeltaGate({ tx, recipientAta, baseUnits }) {
        const evidence = [];
        // (1) the ledger must not carry an error
        if (tx?.meta?.err) return { ok: false, reason: `tx meta.err: ${JSON.stringify(tx.meta.err).slice(0, 120)}`, evidence };
        // (2) instruction-level: exactly one transferChecked of baseUnits into the recipient ATA on MINT
        const parsed = await depositUnitsFromTx(tx, recipientAta);
        const matching = (parsed.payments ?? []).filter((p) => p.kind === "transferChecked" && p.mint === MINT && BigInt(p.raw) === BigInt(baseUnits) && p.decimals === OUSD_WIRE_DECIMALS);
        evidence.push({ checked: "transferChecked into recipient ATA", rows: (parsed.payments ?? []).length, matching: matching.length });
        if (matching.length !== 1) return { ok: false, reason: "delivered-delta gate: no exactly-one matching transferChecked row of the intended units on the configured mint", evidence };
        // (3) balance-level: destination actually holds ≥ the delivered units
        let dest = null;
        try { dest = await tokenAccountAmount(recipientAta); } catch (e) {
            return { ok: false, reason: `delivered-delta gate: destination balance unreadable: ${String(e?.message ?? e).slice(0, 100)}`, evidence };
        }
        evidence.push({ checked: "destinationBalance", dest: dest.toString(), expectedMin: baseUnits.toString() });
        if (dest < BigInt(baseUnits)) return { ok: false, reason: "delivered-delta gate: destination balance below the delivered units", evidence };
        if (BigInt(matching[0].raw) === 0n) return { ok: false, reason: "delivered-delta gate: zero-unit row", evidence };
        return { ok: true, evidence };
    }

    async function dispatchSettlement({ merchant, intent, baseUnits, recipient, recipientAta }) {
        const parties = iso20022Parties(merchant, intent); // throws iso20022_fields_missing (400, no defaults)
        const uetr = crypto.randomUUID();
        if (usedUetrs.has(uetr)) throw new Error("settled uetr collision — regenerate");
        const { paymentId, msgId, memo } = buildSettlementWireParts({ merchant, intent, uetr, baseUnits });

        // pacs.008 is pre-validated BEFORE any dispatch — a wire that fails the
        // 14-point CBPR+ structural gate never leaves the process.
        const pacs008 = CBPRPlusValidator.buildPacs008({
            paymentId,
            uetr,
            instructedAmount: (Number(baseUnits) / 1e6).toFixed(2), // raw OUSD units -> major units ($)
            currency: "USD",
            debtorName: parties.debtorName, debtorBic: parties.debtorBic,
            creditorName: parties.creditorName, creditorBic: parties.creditorBic,
            chargeBearer: "SHAR", // no levy in v0.2 — tsa_bps is 0, ChrgsInf absent
        });
        const validation = CBPRPlusValidator.validate(pacs008.xml);
        if (!validation.valid) {
            throw new Refusal(500, { error: { type: "bridge_error", code: "cbpr_build_rejected", score: validation.score, message: `pacs.008 failed structural validation (${validation.score}) — refused, no fallback wire is ever built.` } });
        }

        // ix order: [ComputeBudget CU-limit, ATokenGP CreateIdempotent if destination absent, MEMO_V2, transferChecked]
        const instructions = [ { programId: "ComputeBudget111111111111111111111111111111", keys: [], data: setComputeUnitLimitData(100_000) } ];
        let destPre = await requireDestinationBalanceReady(recipientAta, baseUnits);
        if (destPre === null) {
            instructions.push({
                programId: ATA_PROGRAM,
                keys: createIdempotentAccounts({ payerPubkey: custody.pubkey, ataB58: recipientAta, walletB58: recipient, tokenProgramB58: TOKEN_2022, mintB58: MINT }),
                data: createIdempotentData(),
            });
            destPre = 0n; // absent pre-balance becomes 0 once creation lands
        }
        instructions.push(buildMemoV2Ix(memo, custody.pubkey));
        instructions.push(buildTransferCheckedIx({
            source: custodyAta, mint: MINT, destination: recipientAta,
            authority: custody.pubkey, amount: BigInt(baseUnits), decimals: OUSD_WIRE_DECIMALS,
        }));

        let custPre;
        try { custPre = await tokenAccountAmount(custodyAta); }
        catch (e) { if (/not found on-chain/.test(String(e?.message ?? e))) custPre = 0n; else throw e; }
        if (custPre < BigInt(baseUnits)) {
            throw new Refusal(402, {
                error: { type: "card_error", code: "insufficient_funds", message: `Bridge custody holds ${custPre} raw OUSD units, settlement needs ${baseUnits}. Prefund via POST /v1/deposits.` },
                refusal: { reason: "bridge_custody_unfunded", custody_holds: custPre.toString(), required: baseUnits.toString(), custody_ata: custodyAta },
            }, { reason: "bridge_custody_unfunded" });
        }
        const custodySol = (await readCustodySol()) ?? 0n;
        const solNeeded = destPre >= 0n && instructions.some((ix) => ix.programId === ATA_PROGRAM) ? CUSTODY_SOL_BUFFER : CUSTODY_SOL_FEE_ONLY;
        if (custodySol < solNeeded) {
            throw new Refusal(402, {
                error: { type: "card_error", code: "bridge_custody_unfunded", message: "Bridge custody lacks lamports for fees/ATA rent — the operator must prefund custody SOL." },
                refusal: { reason: "bridge_custody_unfunded", custody_sol_lamports: custodySol.toString(), required: solNeeded.toString() },
            }, { reason: "bridge_custody_unfunded" });
        }

        let base64Tx = null;
        let blockhash = null;
        const signWithBh = async () => {
            // signSolanaTx returns the serialized tx as ONE base64 string.
            blockhash = await solanaBlockhash(20_000);
            base64Tx = signSolanaTx({ payer: custody, blockhash, instructions });
            if (typeof base64Tx !== "string") {
                throw new Error(`signSolanaTx returned a non-serializable object: ${typeof base64Tx}`);
            }
            return base64Tx;
        };
        await signWithBh();
        const rebuildTx = () => signWithBh();

        // Dispatch, serialize per custody key: one settlement in flight at a
        // time. The MERCHANT-balance debit check also runs inside the queue —
        // two concurrent confirms must not both pass check-then-debit
        // (a prepaid balance spent twice would produce a false success).
        return settlementQueue(async () => {
            const merchantBal = balances.get(merchant.id) ?? 0n;
            if (merchantBal < BigInt(baseUnits)) {
                throw new Refusal(402, {
                    error: { type: "card_error", code: "insufficient_funds", message: `Merchant prepaid balance ${(Number(merchantBal) / 1e6).toFixed(4)} OUSD < ${(Number(baseUnits) / 1e6).toFixed(4)} OUSD. Prefund via POST /v1/deposits (memo X402:${merchant.id}).` },
                    refusal: { reason: "insufficient_funds", merchant_balance_raw: merchantBal.toString(), required_raw: BigInt(baseUnits).toString() },
                }, { refusal: "insufficient_funds" });
            }
            let signature = null;
            let slot = null;
            let gate = null;
            try {
                const sent = await sendAndConfirmSolanaTx(base64Tx, { timeoutMs: 20_000, confirmMs: CONFIRM_MS, rebuildTx });
                signature = sent?.signature ?? signature;
                slot = sent?.slot ?? slot;
            } catch (e) {
                const msg = String(e?.message ?? e);
                // settled-pending-index class: the tx LANDED, only its meta
                // re-read failed — recover the signature and treat as
                // "processing", verify-on-read never re-sends (exact-once).
                const mMatch = /meta re-read failed:\s*([1-9A-HJ-NP-Za-km-z]{60,100})/.exec(msg);
                if (mMatch) {
                    signature = mMatch[1];
                    intent.status = "processing";
                    intent.settle = { uetr, msgId, paymentId, baseUnits: baseUnits.toString(), signature, gate: null, attemptedAt: Date.now() };
                    persistIntent(intent);
                    intents.set(intent.id, intent);
                    return { intent, phase: "processing", signature, reason: "meta re-read failed — tx landed, verify-on-read will complete it" };
                }
                // Confirm-window expiry (15s law): no send-failure semantics —
                // the tx MIGHT have landed; honest status is "processing", and
                // GET confirm-reads. Never auto-retry with a NEW wire (a
                // double-settlement would be a false success).
                intent.status = "processing";
                intent.settle = { uetr, msgId, paymentId, baseUnits: baseUnits.toString(), signature: null, gate: null, attemptedAt: Date.now(), lastError: msg.slice(0, 300) };
                persistIntent(intent);
                intents.set(intent.id, intent);
                return { intent, phase: "processing", signature: null, reason: msg.slice(0, 300) };
            }

            // Confirmed — settle the gate.
            const settledTx = await getSettledTx(signature, { attempts: 5, gapMs: 3000 });
            if (!settledTx) {
                intent.status = "processing";
                intent.settle = { uetr, msgId, paymentId, baseUnits: baseUnits.toString(), signature, gate: null, attemptedAt: Date.now() };
                persistIntent(intent);
                intents.set(intent.id, intent);
                return { intent, phase: "processing", signature, reason: "tx confirmed but on-chain meta not yet indexed — verify-on-read will complete it" };
            }
            gate = await deliveredDeltaGate({ tx: settledTx, recipientAta, baseUnits });
            slot = settledTx?.meta?.slot ?? slot;
            if (gate.ok) {
                return { intent, phase: "succeeded", signature, slot, gate, uetr, msgId, paymentId, pacs008 };
            }
            // The gate FAILED post-confirmation — this must surface loudly.
            // No debit, no succeeded, no pacs.002; status 'settlement_broken'.
            intent.status = "settlement_broken";
            intent.settle = { uetr, msgId, paymentId, baseUnits: baseUnits.toString(), signature, gate, attemptedAt: Date.now() };
            persistIntent(intent);
            intents.set(intent.id, intent);
            ledger({ ts: Date.now(), kind: "settlement_broken", merchant: merchant.id, intent_id: intent.id, signature, slot, gate });
            return { intent, phase: "settlement_broken", signature, slot, gate, reason: "delivered-delta gate failed after confirmation — status is broken, never succeeded" };
        });
    }

    async function completeSettlement({ merchant, intent, dispatch }) {
        // Called with the post-gate SUCCESS envelope: debit the merchant, emit
        // pacs.002 Acsc + webhook, ledger the settlement row. Returns the API
        // intent body.
        usedUetrs.add(dispatch.uetr);
        ledger({
            ts: Date.now(), kind: "settlement", merchant: merchant.id, intent_id: intent.id,
            units: intent.baseUnitsRaw, signature: dispatch.signature, slot: dispatch.slot, status: "succeeded", uetr: dispatch.uetr,
        });
        balances.set(merchant.id, (balances.get(merchant.id) ?? 0n) - BigInt(intent.baseUnitsRaw));
        intent.status = "succeeded";
        intent.settle = {
            uetr: dispatch.uetr, msgId: dispatch.msgId, paymentId: dispatch.paymentId,
            baseUnits: intent.baseUnitsRaw, signature: dispatch.signature, slot: dispatch.slot,
            gate: dispatch.gate, attemptedAt: Date.now(),
        };
        // Stripe-shaped receipt URL, only from a REAL confirmed signature (F9).
        intent.receipt_url = `https://explorer.solana.com/tx/${dispatch.signature}?cluster=devnet`;
        persistIntent(intent);
        intents.set(intent.id, intent);

        const pacs002 = CBPRPlusValidator.buildPacs002({
            originalMsgId: dispatch.msgId, uetr: dispatch.uetr,
            instructedAmount: (Number(intent.baseUnitsRaw) / 1e6).toFixed(2), currency: "USD",
            debtorBic: intent.metaParties.debtorBic, creditorBic: intent.metaParties.creditorBic,
            status: "Acsc", railSignature: dispatch.signature, railSlot: String(dispatch.slot ?? ""),
        });
        const pacs002Ref = { xml: pacs002.xml, status: pacs002.status, originalMsgId: pacs002.originalMsgId, uetr: pacs002.uetr };

        // Webhook really is delivered (F7): POST Stripe-shaped event with HMAC
        // `t=<unix>,v1=<hex>`; ×3 attempts, attempts recorded.
        const webhookAttempts = await deliverWebhook(merchant, intent, pacs002Ref);

        return { intent, pacs002: pacs002Ref, webhookAttempts, phase: "succeeded" };
    }

    async function deliverWebhook(merchant, intent, pacs002) {
        if (!merchant.webhookUrl) return { attempted: true, delivered: false, reason: "no webhook_url configured for merchant", attempts: 0 };
        if (!merchant.webhookSecret) return { attempted: true, delivered: false, reason: "no webhook_secret configured for merchant", attempts: 0 };
        const payload = {
            id: `evt_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
            object: "event", type: "payment_intent.succeeded",
            created: Math.floor(Date.now() / 1000),
            data: { object: { id: intent.id, object: "payment_intent", amount: intent.amount, currency: intent.currency, status: intent.status, receipt_url: intent.receipt_url, metadata: intent.metadata, iso20022: { pacs002: pacs002.xml } } },
        };
        const bodyRaw = JSON.stringify(payload);
        const t = Math.floor(Date.now() / 1000);
        const v1 = crypto.createHmac("sha256", merchant.webhookSecret).update(`${t}.${bodyRaw}`).digest("hex");
        const attempts = [];
        for (let i = 1; i <= 3; i++) {
            try {
                const res = await fetch(merchant.webhookUrl, {
                    method: "POST",
                    headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${v1}`, "user-agent": `syn-stripe-bridge/${BRIDGE_VERSION}` },
                    body: bodyRaw,
                    signal: AbortSignal.timeout(10_000),
                });
                attempts.push({ attempt: i, status: res.status });
                if (res.ok) { ledger({ ts: Date.now(), kind: "webhook", merchant: merchant.id, intent_id: intent.id, delivered: true, attempts: i }); return { attempted: true, delivered: true, status: res.status, attempts: i, log: attempts }; }
            } catch (e) { attempts.push({ attempt: i, error: String(e?.message ?? e).slice(0, 160) }); }
        }
        ledger({ ts: Date.now(), kind: "webhook", merchant: merchant.id, intent_id: intent.id, delivered: false, attempts: attempts.length });
        return { attempted: true, delivered: false, attempts: attempts.length, log: attempts };
    }

    // verify-on-read for processing intents: never re-sends, just completes.
    async function tryVerifyOnRead(merchant, intent) {
        if (intent.status !== "processing" || !intent.settle?.signature) return intent;
        const settledTx = await getSettledTx(intent.settle.signature, { attempts: 3, gapMs: 2000 });
        if (!settledTx) return intent; // still indexing; ledger-time-lag law: null reads are not evidence either way
        const gate = await deliveredDeltaGate({ tx: settledTx, recipientAta: intent.recipientAta, baseUnits: intent.baseUnitsRaw });
        if (!gate.ok) { intent.lastVerifyNote = gate.reason; return intent; } // honest note, no status flip
        const parties = iso20022Parties(merchant, intent); // parties still required, deterministic
        const msgId = `SBR${intent.id.replace(/[^0-9a-zA-Z._-]/g, "").slice(-30)}`;
        const pacs008 = CBPRPlusValidator.buildPacs008({
            paymentId: msgId,
            uetr: intent.settle.uetr,
            instructedAmount: (Number(intent.baseUnitsRaw) / 1e6).toFixed(2),
            currency: "USD",
            debtorName: parties.debtorName, debtorBic: parties.debtorBic,
            creditorName: parties.creditorName, creditorBic: parties.creditorBic,
            chargeBearer: "SHAR",
        });
        const result = await completeSettlement({
            merchant, intent,
            dispatch: { uetr: intent.settle.uetr, msgId, paymentId: msgId, pacs008, signature: intent.settle.signature, slot: settledTx?.meta?.slot, gate },
        });
        intent.pacs002 = result.pacs002;
        intent.webhookAttempts = result.webhookAttempts;
        return intent;
    }

    // ---------------- HTTP surface ----------------
    function intentBody(merchant, intent) {
        return {
            id: intent.id, object: "payment_intent", amount: intent.amount, currency: intent.currency,
            status: intent.status, created: intent.created, client_secret: intent.client_secret,
            metadata: intent.metadata, receipt_url: intent.receipt_url ?? null,
            iso20022: intent.pacs002 ? { pacs002: intent.pacs002.xml, uetr: intent.settle?.uetr, rail_signature: intent.settle?.signature, rail_slot: intent.settle?.slot } : null,
            last_verification: intent.settle?.gate ?? null,
            last_payment_error: intent.lastError ?? null,
        };
    }

    const handlers = {
        "GET /health": async () => {
            let rail = null;
            try { rail = await custodyReadiness(); } catch (e) { rail = { error: String(e?.message ?? e).slice(0, 200) }; }
            return {
                ok: true, version: BRIDGE_VERSION, rail: { chain: RAIL, ousd_mint: MINT, decimals: OUSD_WIRE_DECIMALS },
                custody: rail, merchants_loaded: merchants.byId.size,
            };
        },
    };

    async function createPaymentIntent(merchant, body, req) {
        // No defaults of any kind (F9): absent amount is a 400, amount must be
        // an integer ≥ 1, currency must be present and equal to 'usd'.
        const amount = body?.amount;
        if (amount === undefined || amount === null || amount === "") {
            throw new Refusal(400, { error: { type: "invalid_request_error", code: "amount_required", message: "amount is required — the bridge never applies a default amount." } });
        }
        if (!Number.isSafeInteger(Number(amount)) || Number(amount) < 1 || Number(amount) !== Number(amount)) {
            throw new Refusal(400, { error: { type: "invalid_request_error", code: "amount_invalid", message: "amount must be an integer number of cents ≥ 1." } });
        }
        const amountInt = Number(amount);
        const currency = body?.currency;
        if (!currency) throw new Refusal(400, { error: { type: "invalid_request_error", code: "currency_required", message: "currency is required (v0.2 settles 'usd' => devnet OUSD)." } });
        if (String(currency).toLowerCase() !== "usd") {
            throw new Refusal(400, { error: { type: "invalid_request_error", code: "unsupported_currency", message: `Unsupported currency '${currency}': v0.2 settles usd → devnet OUSD only (1 OUSD = $1).` } });
        }
        // tsa levy: not configured in v0.2 — a requested levy would be a fake movement.
        const tsaBps = body?.metadata?.tsa_bps ?? body?.tsa_bps;
        if (tsaBps !== undefined && tsaBps !== null && Number(tsaBps) !== 0) {
            throw new Refusal(400, { error: { type: "invalid_request_error", code: "levy_not_configured", message: "tsa_bps must be 0 (unset): the bridge levy rail is not configured — refusing to fabricate a charge." } });
        }
        const recipientIn = body?.metadata?.solana_recipient ?? body?.recipient;
        if (!recipientIn) {
            throw new Refusal(400, { error: { type: "invalid_request_error", code: "recipient_required", message: "metadata.solana_recipient is required — the bridge never uses a default destination." }, refusal: { reason: "recipient_required" } });
        }
        const recRaw = b58decode32(recipientIn);
        if (!recRaw) throw new Refusal(400, { error: { type: "invalid_request_error", code: "recipient_invalid", message: "metadata.solana_recipient must be a base58 pubkey (32 bytes)." } });
        const recipient = String(recipientIn);

        const idempotencyKey = req.headers["idempotency-key"] ?? body?.idempotency_key ?? null;
        if (idempotencyKey && idempotency.has(`${merchant.id}:${idempotencyKey}`)) {
            const stored = idempotency.get(`${merchant.id}:${idempotencyKey}`);
            return { status: stored.status ?? 201, body: stored.body, idempotentReplay: true };
        }

        const intentId = `pi_syn_${crypto.randomBytes(12).toString("hex")}`;
        const intent = {
            id: intentId, object: "payment_intent", amount: amountInt, currency: String(currency).toLowerCase(),
            status: "requires_confirmation", created: Math.floor(Date.now() / 1000),
            client_secret: `${intentId}_secret_${crypto.randomBytes(12).toString("hex")}`,
            merchant: merchant.id, metadata: body?.metadata ?? {},
            recipient, recipientAta: deriveAssociatedTokenAddress(recipient, TOKEN_2022, MINT),
            baseUnitsRaw: (BigInt(amountInt) * RAW_UNITS_PER_CENT).toString(),
            idempotencyKey,
            metaParties: null, // resolved at confirm (iso20022_fields_missing is a confirm-time refusal)
        };
        intents.set(intentId, intent);
        persistIntent(intent);
        const bodyOut = intentBody(merchant, intent);
        if (idempotencyKey) idempotency.set(`${merchant.id}:${idempotencyKey}`, { status: 201, body: bodyOut });
        return { status: 201, body: bodyOut };
    }

    function getMerchantIntent(merchant, id) {
        if (!intents.has(id)) return null;
        const intent = intents.get(id);
        if (intent.merchant !== merchant.id) return null;
        return intent;
    }

    async function confirmPaymentIntent(merchant, id) {
        const intent = getMerchantIntent(merchant, id);
        if (!intent) throw new Refusal(404, { error: { type: "invalid_request_error", code: "resource_missing", message: `No such payment_intent '${id}' for this merchant.` } });
        if (intent.status === "succeeded") return { status: 200, body: intentBody(merchant, intent), phase: "succeeded" };
        if (intent.status === "settlement_broken") throw new Refusal(500, { error: { type: "bridge_error", code: "settlement_broken", message: "A prior settlement attempt failed the delivered-delta gate — never retried here; investigate the on-chain evidence before any re-dispatch." , gate: intent.settle?.gate} });
        if (intent.status !== "requires_confirmation" && intent.status !== "processing") {
            throw new Refusal(409, { error: { type: "invalid_request_error", code: "invalid_state", message: `payment_intent is '${intent.status}' and cannot be confirmed.` } });
        }

        // Malformed-request checks come BEFORE readiness checks: missing ISO
        // 20022 party fields are a 400 even when the balance is also short —
        // a wire that cannot name its banks is not a funds problem.
        const parties = iso20022Parties(merchant, intent); // 400 without all fields (no fabricated banks, F8)
        intent.metaParties = parties;

        // Readiness preflight (F6): everything is refused VERBATIM before any dispatch.
        const baseUnits = BigInt(intent.baseUnitsRaw);
        const merchantBal = balances.get(merchant.id) ?? 0n;
        if (merchantBal < baseUnits) {
            throw new Refusal(402, {
                error: { type: "card_error", code: "insufficient_funds", message: `Merchant prepaid balance ${(Number(merchantBal) / 1e6).toFixed(4)} OUSD < ${(Number(baseUnits) / 1e6).toFixed(4)} OUSD. Prefund via POST /v1/deposits (memo X402:${merchant.id}).` },
                refusal: { reason: "insufficient_funds", merchant_balance_raw: merchantBal.toString(), required_raw: baseUnits.toString() },
            }, { refusal: "insufficient_funds" });
        }

        const dispatch = await dispatchSettlement({ merchant, intent, baseUnits, recipient: intent.recipient, recipientAta: intent.recipientAta });

        if (dispatch.phase === "succeeded") {
            const done = await completeSettlement({ merchant, intent, dispatch });
            return { status: 200, body: intentBody(merchant, intent), phase: "succeeded", extra: { pacs002: done.pacs002, webhook: done.webhookAttempts } };
        }
        if (dispatch.phase === "processing") {
            return { status: 202, body: intentBody(merchant, intent), phase: "processing" };
        }
        if (dispatch.phase === "settlement_broken") {
            return { status: 500, body: (s => ({ ...s, gate: intent.settle?.gate }))(intentBody(merchant, intent)), phase: "settlement_broken" };
        }
        throw new Error(`dispatchSettlement returned unknown phase '${dispatch.phase}' — refuse loud`);
    }

    async function verifyDeposit(merchant, body) {
        const signature = body?.signature;
        if (!signature) throw new Refusal(400, { error: { type: "invalid_request_error", code: "signature_required", message: "deposit signature is required — the bridge verifies on-chain delivery itself, it never trusts a posted amount." } });
        if (depositSigners.has(signature)) {
            throw new Refusal(409, { error: { type: "invalid_request_error", code: "already_credited", message: `signature '${signature}' has already been credited — exact-once.` }, refusal: { reason: "already_credited" } });
        }
        const tx = await getSettledTx(signature, { attempts: 5, gapMs: 3000 });
        if (!tx) throw new Refusal(404, { error: { type: "invalid_request_error", code: "ledger_time_lag", message: `signature '${signature}' not yet indexed by the RPC (ledger-time lag) — retry shortly; a null read is never evidence.` } });
        if (tx?.meta?.err) {
            throw new Refusal(400, { error: { type: "invalid_request_error", code: "deposit_tx_failed", message: `deposit transaction FAILED on-chain: ${JSON.stringify(tx.meta.err).slice(0, 120)} — errored transactions are never evidence.` } });
        }
        const parsed = await depositUnitsFromTx(tx, custodyAta);
        const rows = (parsed.payments ?? []).filter((p) => p.mint === MINT && p.decimals === OUSD_WIRE_DECIMALS && p.memo === `X402:${merchant.id}`);
        if (rows.length === 0) {
            const memosFound = (parsed.payments ?? []).map((p) => `${p.kind}/${p.mint}/${p.memo ?? "<no memo>"}`).slice(0, 5);
            throw new Refusal(400, {
                error: { type: "invalid_request_error", code: "deposit_not_evidenced", message: `No transferChecked into bridge custody on ${MINT} carrying memo "X402:${merchant.id}" was found in this transaction. Rows seen: ${memosFound.join(", ") || "none"}.` },
                refusal: { reason: "deposit_not_evidenced", expected_memo: `X402:${merchant.id}` },
            });
        }
        const units = rows.reduce((acc, r) => acc + BigInt(r.raw), 0n);
        depositSigners.add(signature); // single-use NOW, before any response — replay is impossible (exact-once)
        ledger({ ts: Date.now(), kind: "deposit", verified: true, merchant: merchant.id, signature, units: units.toString(), memo: `X402:${merchant.id}`, mints_verified: true });
        balances.set(merchant.id, (balances.get(merchant.id) ?? 0n) + units);
        return { status: 201, body: {
            object: "bridge_deposit", merchant: merchant.id, signature, units: units.toString(),
            ousd_major: (Number(units) / 1e6), verified_from_chain: true, memo: `X402:${merchant.id}`,
            balance: { raw: (balances.get(merchant.id) ?? 0n).toString(), ousd_major: Number(balances.get(merchant.id) ?? 0n) / 1e6 },
        } };
    }

    async function merchantBalance(merchant) {
        const raw = balances.get(merchant.id) ?? 0n;
        return { status: 200, body: { object: "balance", merchant: merchant.id, raw: raw.toString(), ousd_major: Number(raw) / 1e6, pending: 0 } };
    }

    async function custodyDiagnostics() {
        const r = await custodyReadiness();
        const custOusd = r.custodyOusdRaw === null ? null : Number(r.custodyOusdRaw) / 1e6;
        return { status: 200, body: { object: "custody_diagnostics", ...r, custody_ousd_major: custOusd, raw_units_per_cent: RAW_UNITS_PER_CENT.toString(), mainnet_mint_refused: OUSD_MAINNET_REGISTRY_MINT } };
    }

    function readBody(req) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf8");
                if (!raw) return resolve({});
                const ct = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
                if (ct === "application/x-www-form-urlencoded") {
                    // Stripe SDKs (stripe-python, stripe-node) POST form-encoded
                    // bodies: amount=1000&currency=usd&metadata[key]=v. The
                    // drop-in contract means reading THEIR dialect, not demanding
                    // ours — parse bracket notation into nested objects.
                    try { resolve(parseStripeForm(raw)); } catch { resolve({ __raw: raw }); }
                    return;
                }
                try { resolve(JSON.parse(raw)); } catch { resolve({ __raw: raw }); }
            });
            req.on("error", reject);
        });
    }

    function parseStripeForm(raw) {
        const out = {};
        for (const [k, v] of new URLSearchParams(raw)) {
            const m = /^([^\[\]]*)((?:\[[^\[\]]*\])*)$/.exec(k);
            if (!m) continue;
            const base = m[1];
            const fieldPath = (m[2].match(/\[([^\[\]]*)\]/g) ?? []).map((s) => s.slice(1, -1));
            if (!base && fieldPath.length === 0) continue;
            if (fieldPath.length === 0) { out[k] = v === "true" ? true : v === "false" ? false : v; continue; }
            let node = out[base];
            if (!(out[base] instanceof Object) || Array.isArray(out[base])) node = out[base] = {};
            for (let i = 0; i < fieldPath.length - 1; i++) {
                if (!(node[fieldPath[i]] instanceof Object) || Array.isArray(node[fieldPath[i]])) node[fieldPath[i]] = {};
                node = node[fieldPath[i]];
            }
            node[fieldPath[fieldPath.length - 1]] = v === "true" ? true : v === "false" ? false : v;
        }
        return out;
    }
    void validateB58Pubkey; // kept for offline tests; the shim itself uses b58decode32
    function validateB58Pubkey(s) { return b58decode32(s) !== null ? true : false; }

    async function handleStripeRequest(req, res) {
        const started = Date.now();
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const pathname = url.pathname;
        const method = (req.method ?? "GET").toUpperCase();

        const send = (status, body) => {
            const out = JSON.stringify(body);
            res.writeHead(status, { "content-type": "application/json", "x-bridge-version": BRIDGE_VERSION });
            res.end(out);
            return { status, ms: Date.now() - started };
        };
        try {
            if (method === "GET" && pathname === "/health") { return send(200, await handlers["GET /health"]()); }
            if (method === "GET" && pathname === "/v1/custody") return send(200, (await custodyDiagnostics()).body);
            if (pathname.startsWith("/v1/")) {
                const merchant = auth(req); // fail-closed everything under /v1
                let body = {};
                if (method === "POST" || method === "PUT") body = await readBody(req);
                if (method === "POST" && pathname === "/v1/payment_intents") {
                    const r = await createPaymentIntent(merchant, body, req);
                    return send(r.status, r.body);
                }
                if (method === "GET" && pathname.startsWith("/v1/payment_intents/")) {
                    const id = pathname.split("/")[3];
                    const intent = getMerchantIntent(merchant, id);
                    if (!intent) return send(404, { error: { type: "invalid_request_error", code: "resource_missing", message: `No such payment_intent '${id}' for this merchant.` } });
                    const updated = await tryVerifyOnRead(merchant, intent); // ledger-time-lag law
                    return send(200, intentBody(merchant, updated));
                }
                if (method === "POST" && /^\/v1\/payment_intents\/[^/]+\/confirm$/.test(pathname)) {
                    const id = pathname.split("/")[3];
                    const r = await confirmPaymentIntent(merchant, id);
                    return send(r.status, r.phase === "succeeded" ? { ...r.body, iso20022: r.extra?.pacs002 ? { ...r.body.iso20022, pacs002_report: r.extra.pacs002 } : r.body.iso20022, webhook: r.extra?.webhook } : r.body);
                }
                if (method === "POST" && pathname === "/v1/deposits") {
                    const r = await verifyDeposit(merchant, body);
                    return send(r.status, r.body);
                }
                if (method === "GET" && pathname === "/v1/balance") {
                    const r = await merchantBalance(merchant);
                    return send(200, r.body);
                }
                return send(404, { error: { type: "invalid_request_error", code: "resource_missing", message: `Unknown bridge endpoint ${method} ${pathname}.` } });
            }
            return send(404, { error: { type: "invalid_request_error", code: "resource_missing", message: `Unknown bridge endpoint ${method} ${pathname}.` } });
        } catch (e) {
            if (e instanceof Refusal) return send(e.httpStatus, e.body);
            return send(500, { error: { type: "bridge_error", code: "internal", message: `${String(e?.message ?? e).slice(0, 300)}` } });
        }
    }

    function listen(cb) {
        const server = http.createServer((rq, rs) => handleStripeRequest(rq, rs));
        return server.listen(cfg.port, cfg.host, cb);
    }

    return {
        handleStripeRequest, listen, cfg, custody, MINT, custodyAta,
        state: { balances, intents, depositSigners, idempotency, usedUetrs, merchants },
        validateB58Pubkey,
    };
}

// Standalone entry: node src/stripe_shim.mjs
// IMPORTANT: under pm2 fork mode, process.argv[1] is PM2's ProcessContainerFork.js,
// NOT this script — the runtime script path is pm_exec_path there. Detect both,
// or the process boots as an idle zombie (listens on nothing, logs nothing).
const SELF_PATH = path.resolve(fileURLToPath(import.meta.url));
const argvPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const pm2Path = process.env.pm_exec_path ? path.resolve(process.env.pm_exec_path) : "";
const isMain = argvPath === SELF_PATH || pm2Path === SELF_PATH;
if (isMain) {
    const bridge = createBridgeServer();
    bridge.listen(() => console.log(`syn-stripe-bridge v${BRIDGE_VERSION} listening on ${bridge.cfg.host}:${bridge.cfg.port} (rail ${RAIL}, OUSD ${bridge.MINT}, custody ${bridge.custody.pubkey})`));
}