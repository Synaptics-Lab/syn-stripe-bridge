/**
 * token-evidence.mjs — on-chain Token-2022 evidence reader for the bridge.
 *
 * Ported from the estate's live-verified desk parser
 * (`nodes-api/rail-exchange/desk-ousd.mjs`: keyResolver / iterIxs / memoStrings /
 * tokenTransfer / scanTx) — the wire-grammar parsing is NEVER reinvented
 * downstream; this file is a straight adaptation of those functions to the
 * bridge's JSON-RPC accessor (the vendored estate wire stack) and its two uses:
 *
 *   1. DEPOSITS — `depositUnitsFromTx(tx, custodyAta, mint)`: every Token-2022
 *      transfer INTO the custody ATA of a settled transaction. transferChecked
 *      rows carry mint+decimals on the wire (hard-checked); plain `transfer`
 *      rows require a getAccountInfo re-read of the SOURCE account to confirm
 *      the mint (mismatched-mint plain transfers are the classic Token-2022
 *      footgun — refused, never guessed). Delivered units come from the
 *      INSTRUCTION bytes, never from a client's claim.
 *   2. MEMO recovery — the memo text accompanying the transfer, for the
 *      X402:<merchant_id> deposit routing tag.
 *
 * Fail-closed: an errored (meta.err) transaction is never evidence; the caller
 * decides the verdict shape.
 */

import { solanaRpc } from "../vendor/solana-tx.mjs";

const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MEMO_PROGRAMS = new Set(["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"]);
const IX_TRANSFER = 3;           // SPL transfer (no mint on the wire)
const IX_TRANSFER_CHECKED = 12;  // SPL transfer_checked [12][u64LE amount][u8 decimals]

// base58 decode for instruction-data strings (base64-encoded SPL ix data in
// jsonParsed meta arrives as base58 here, same wire convention as the desk).
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = new Map([...B58_ALPHABET].map((c, i) => [c, i]));

function b58decode(s) {
    if (typeof s !== "string" || s.length === 0) return null;
    const bytes = [];
    for (const ch of s) {
        const val = B58_MAP.get(ch);
        if (val === undefined) return null;
        let carry = val;
        for (let i = 0; i < bytes.length; i++) {
            carry += bytes[i] * 58;
            bytes[i] = carry & 0xff;
            carry >>= 8;
        }
        while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    for (const ch of s) {
        if (ch !== "1") break;
        bytes.push(0);
    }
    return Uint8Array.from(bytes.reverse());
}

/** Account-key resolver over the FULL address set (static + loaded). */
function keyResolver(tx) {
    const msg = tx?.transaction?.message;
    if (!msg) return { keyAt: () => null };
    const staticKeys = (msg?.accountKeys || []).map((k) => (typeof k === "string" ? k : k?.pubkey));
    const loaded = [
        ...((tx?.meta?.loadedAddresses?.writable) || []),
        ...((tx?.meta?.loadedAddresses?.readonly) || []),
    ];
    const all = [...staticKeys, ...loaded];
    return { keyAt: (i) => all[i] ?? null };
}

/** Outer + inner instructions, flat. */
function iterIxs(tx) {
    const msg = tx?.transaction?.message;
    if (!msg) return [];
    const all = [...(msg.instructions || [])];
    for (const inner of (tx?.meta?.innerInstructions || [])) {
        all.push(...(inner.instructions || []));
    }
    return all;
}

/** SPL Memo v2 strings carried by the tx (program-resolved through keyAt). */
function memoStrings(tx) {
    const { keyAt } = keyResolver(tx);
    const out = [];
    for (const ix of iterIxs(tx)) {
        if (!MEMO_PROGRAMS.has(keyAt(ix.programIdIndex))) continue;
        const raw = b58decode(ix.data);
        if (raw) out.push(Buffer.from(raw).toString("utf8"));
    }
    return out;
}

/** One Token-2022 transfer instruction -> {to, raw, mint|null, source, payer}. */
function tokenTransfer(tx, ix, keyAt) {
    if (keyAt(ix.programIdIndex) !== TOKEN_2022_PROGRAM) return null;
    const raw = b58decode(ix.data);
    if (!raw || raw.length < 9) return null;
    const tag = raw[0];
    const accts = ix.accounts || [];
    if (tag === IX_TRANSFER_CHECKED && raw.length >= 10) {
        let amt = 0;
        for (let i = 8; i >= 1; i--) amt = amt * 256 + raw[i];
        const decimals = raw[9];
        return {
            kind: "transferChecked", raw: amt, decimals,
            mint: keyAt(accts[1]), to: keyAt(accts[2]), source: keyAt(accts[0]), payer: keyAt(accts[3]),
        };
    }
    if (tag === IX_TRANSFER) {
        let amt = 0;
        for (let i = 8; i >= 1; i--) amt = amt * 256 + raw[i];
        return {
            kind: "transfer", raw: amt, decimals: null, mint: null,
            to: keyAt(accts[1]), source: keyAt(accts[0]), payer: keyAt(accts[2]),
        };
    }
    return null;
}

/**
 * Token-2022 transfers INTO `ata` of a settled tx, delivered units from the
 * instruction bytes. Plain transfers carry the source-account mint re-read.
 * @returns {Array<{kind, raw, decimals, mint, to, source, payer, memo, unfound?}>}
 */
export async function depositUnitsFromTx(tx, ata) {
    if (tx?.meta?.err) return { refunds: tx.meta.err, payments: [] }; // errored tx is never evidence
    const { keyAt } = keyResolver(tx);
    const memos = memoStrings(tx);
    const payments = [];
    for (const ix of iterIxs(tx)) {
        const t = tokenTransfer(tx, ix, keyAt);
        if (!t || t.to !== ata) continue;
        if (t.kind === "transferChecked") {
            payments.push({ ...t, memo: memos.find(Boolean) || null });
        } else {
            // plain transfer: mint is not on the wire — re-read the SOURCE account
            const j = (await solanaRpc("getAccountInfo", [t.source, { encoding: "jsonParsed" }]));
            const acc = j?.result;
            const mint = acc?.value?.data?.parsed?.info?.mint ?? null;
            const decimals = acc?.value?.data?.parsed?.info?.tokenAmount?.decimals ?? null;
            if (!mint) payments.push({ ...t, memo: memos.find(Boolean) || null, decimals: null, mint: null, unfound: "source_mint_unreadable" });
            else payments.push({ ...t, memo: memos.find(Boolean) || null, decimals, mint });
        }
    }
    return { refunds: null, payments };
}

/** getTransaction re-read with bounded retry — devnet INDEXING lags the
 *  confirmation signal (>12s live, 2026-10-06 desk legs); the ledger-time-lag
 *  law forbids treating one null read as evidence either way. */
export async function getSettledTx(sig, { attempts = 15, gapMs = 3000 } = {}) {
    for (let i = 0; i < attempts; i++) {
        if (i) await new Promise((r) => setTimeout(r, gapMs));
        try {
            const j = await solanaRpc("getTransaction", [sig, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 }], 30_000);
            if (j?.error) throw new Error(JSON.stringify(j.error).slice(0, 150)); // transport class
            if (j?.result) return j.result;
        } catch (e) {
            if (i === attempts - 1) throw new Error(`settled tx unreadable on-chain (transport class, not a refusal): ${String(e?.message ?? e).slice(0, 200)}`);
            continue; // transport — retry inside the bounded window
        }
    }
    return null;
}