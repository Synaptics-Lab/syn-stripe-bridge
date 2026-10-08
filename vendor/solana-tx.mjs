/**
 * solana-tx.mjs — R13.3 dependency-free Solana DEVNET tx builder + signer +
 * sender for the escrow server's Solana custodian (the second clearing
 * custodian, one per rail). Plain JSON-RPC writes; node:crypto ed25519 for
 * signing — the escrow server still takes NO new node_modules.
 *
 * Honest rail label: "Solana DEVNET". The two rail labels never blur.
 *
 * Wire format (legacy transactions, no versioned message needed for
 * System-transfer + SPL-Memo payloads):
 *   tx       = compact-u16(numSigs) || sig(64)… || message
 *   message  = header(3 bytes: numRequiredSigs, numReadonlySigned,
 *                      numReadonlyUnsigned)
 *            | compact-u16(numKeys) || keys(32 each)
 *            | blockhash(32)
 *            | compact-u16(numIxs) || per ix: [programIdIndex u8]
 *              [compact-u16 acctsLen] [acct indexes] [compact-u16 dataLen]
 *              [data]
 * The signed payload is the raw message bytes (ed25519, no prehash).
 *
 * Fail-closed: send/confirm never reports success without a confirmed (not
 * just processed) signature and a re-read getTransaction whose meta.err is
 * null. Delivered lamports are the destination's post−pre balance delta from
 * the tx meta — never the requested amount.
 *
 * Rent floor (observed on devnet 2026-09-19): a System transfer to a FRESH
 * account fails simulation below rent exemption (~890,880 lamports for a
 * 0-byte account) — "account (1) with insufficient funds for rent". Solana
 * creditor payouts below that floor fail loudly here by design; a receiving
 * Solana account must be rent-exempt to exist at all. Existing funded
 * accounts can receive any amount.
 */

import crypto from "node:crypto";
import fs from "node:fs";

export const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
export const RAIL = "solana-devnet";

// ---------------- base58 (bitcoin alphabet, no leading-zero compression for
// key material — all our inputs are fixed-length 32/64 bytes) ----------------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58encode(buf) {
  const digits = [];
  for (const byte of buf) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let out = "";
  for (const byte of buf) { if (byte === 0) out += B58[0]; else break; }
  return out + digits.reverse().map((d) => B58[d]).join("");
}

export function b58decode(s) {
  if (typeof s !== "string" || !s.length) return null;
  const bytes = [];
  for (const ch of s) {
    const val = B58.indexOf(ch);
    if (val < 0) return null;
    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  for (const ch of s) { if (ch === B58[0]) zeros++; else break; }
  const out = Buffer.alloc(zeros + bytes.length);
  out.set(Buffer.from(bytes.reverse()), zeros);
  return out;
}

// ---------------- keypair (solana CLI JSON: [seed(32), pubkey(32)]) --------
// The file lives in the vault; its CONTENTS are never printed anywhere.
export function loadKeypair(path) {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  if (!Array.isArray(raw) || raw.length !== 64) {
    throw new Error(`solana custodian keypair file must be a 64-int solana CLI keypair: ${path}`);
  }
  const seed = Buffer.from(raw.slice(0, 32));
  const pub = Buffer.from(raw.slice(32));
  return { seed, pubkey: b58encode(pub) };
}

function ed25519Key(seed) {
  // PKCS8 DER wrapper for a raw ed25519 seed: 302e020100300506032b657004220420
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

// ---------------- compact-u16 + message assembly ---------------------------
function pushCompactU16(out, v) {
  if (!Number.isInteger(v) || v < 0) throw new Error("compact-u16 needs a non-negative integer");
  for (;;) {
    let byte = v & 0x7f;
    v >>= 7;
    if (v) byte |= 0x80;
    out.push(byte);
    if (!v) return;
  }
}

/**
 * Build and sign a legacy Solana transaction.
 * @param {object} o
 * @param {{seed:Buffer, pubkey:string}|{pubkey:string}} o.payer  fee payer
 *   (must carry `seed` to sign; an object without `seed` is only valid when
 *   that key also appears in extraSigners)
 * @param {string} o.blockhash  recent blockhash (base58)
 * @param {Array} o.instructions  [{ programId, keys:[{pubkey,isSigner,isWritable}], data:Buffer }]
 * @param {Array<{seed:Buffer,pubkey:string}>} o.extraSigners  additional signers
 */
export function signSolanaTx({ payer, blockhash, instructions, extraSigners = [] }) {
  const blockhashBytes = b58decode(blockhash);
  if (!blockhashBytes || blockhashBytes.length !== 32) throw new Error("bad blockhash");

  const signers = [];
  const addSigner = (k) => {
    if (k.seed && !signers.some((s) => s.pubkey === k.pubkey)) signers.push(k);
  };
  addSigner(payer);
  for (const s of extraSigners) addSigner(s);

  // Static account keys, in canonical order: signers first (writable then
  // readonly), then the rest (writable then readonly).
  const accountKeys = []; // {pubkey, isSigner, isWritable}
  const push = (pubkey, isSigner, isWritable) => {
    if (accountKeys.some((k) => k.pubkey === pubkey)) return null;
    const idx = accountKeys.length;
    accountKeys.push({ pubkey, isSigner, isWritable });
    return idx;
  };

  // Collect every account referenced by any instruction, then order.
  const referenced = new Map();
  for (const ix of instructions) {
    if (!referenced.has(ix.programId)) referenced.set(ix.programId, { pubkey: ix.programId, isSigner: false, isWritable: false });
    for (const k of ix.keys) {
      const prev = referenced.get(k.pubkey);
      if (prev) { prev.isSigner ||= k.isSigner; prev.isWritable ||= k.isWritable; }
      else referenced.set(k.pubkey, { pubkey: k.pubkey, isSigner: !!k.isSigner, isWritable: !!k.isWritable });
    }
  }
  const refList = [...referenced.values()];
  // signers (writable first), then unsigned writable, then readonly
  for (const s of signers) push(s.pubkey, true, true);
  for (const k of refList) if (k.isSigner && !k.isWritable) push(k.pubkey, true, false);
  for (const k of refList) if (!k.isSigner && k.isWritable) push(k.pubkey, false, true);
  for (const k of refList) if (!k.isSigner && !k.isWritable) push(k.pubkey, false, false);

  const numReadonlySigned = accountKeys.filter((k) => k.isSigner && !k.isWritable).length;
  const numReadonlyUnsigned = accountKeys.filter((k) => !k.isSigner && !k.isWritable).length;

  const msg = [];
  msg.push(signers.length, numReadonlySigned, numReadonlyUnsigned);
  pushCompactU16(msg, accountKeys.length);
  for (const k of accountKeys) msg.push(...b58decode(k.pubkey));
  msg.push(...blockhashBytes);
  pushCompactU16(msg, instructions.length);
  for (const ix of instructions) {
    const progIdx = accountKeys.findIndex((k) => k.pubkey === ix.programId);
    if (progIdx < 0) throw new Error("instruction program missing from account keys");
    msg.push(progIdx);
    pushCompactU16(msg, ix.keys.length);
    for (const k of ix.keys) {
      const idx = accountKeys.findIndex((a) => a.pubkey === k.pubkey);
      if (idx < 0) throw new Error(`instruction account ${k.pubkey} missing from account keys`);
      msg.push(idx);
    }
    pushCompactU16(msg, ix.data.length);
    for (const b of ix.data) msg.push(b);
  }

  const msgBuf = Buffer.from(msg);
  const sigs = signers.map((s) => {
    const key = ed25519Key(s.seed);
    return crypto.sign(null, msgBuf, key);
  });
  if (sigs.some((s) => s.length !== 64)) throw new Error("ed25519 signature must be 64 bytes");

  const tx = [];
  pushCompactU16(tx, sigs.length);
  for (const s of sigs) tx.push(...s);
  tx.push(...msgBuf);
  return Buffer.from(tx).toString("base64");
}

// ---------------- JSON-RPC ----------------
// Failover law (operator 2026-10-07, mirrors escrow-server/solana-tx.mjs):
// the public devnet endpoint rate-limits the desk's poll bursts; a paid
// Helius devnet endpoint is the FALLBACK. The API key is a vault FILE —
// PATH-referenced (SOLANA_RPC_FALLBACK_FILE wins) or passed whole as
// SOLANA_RPC_FALLBACK_URL (tests) — and the URL is composed at runtime. The
// key never enters code, env dumps, client bundles or receipts: this module
// resolves it server-side only, and with neither env set the resolver is a
// no-op (public devnet stays primary, unchanged behavior). Failover is PER
// CALL on transport classes only (fetch throw / abort / non-JSON body such
// as a 429 HTML page, or a JSON-RPC 429 rate-limit error — a 429 is "the
// node never answered the question" whether the edge writes it as HTML or
// JSON); verdict-shaped JSON (tx results, non-429 JSON-RPC errors) is
// returned as-is — the callers' bounded ladders (blockhash probes, confirm
// backoff rungs) classify verdicts and stay in charge. If the fallback ALSO
// 429s from its final endpoint, its body is returned unchanged so the
// caller's error wording ("blockhash unavailable: {429}") and ladder
// budgets stay intact. A misconfigured file
// fails loud on the first RPC and is never retried as transport.
const HELIUS_DEVNET = "https://devnet.helius-rpc.com/?api-key=";

function solanaFallbackUrl() {
  const file = process.env.SOLANA_RPC_FALLBACK_FILE;
  const url = process.env.SOLANA_RPC_FALLBACK_URL;
  if (file === undefined && url === undefined) return null;
  if (file) {
    let raw;
    try { raw = fs.readFileSync(file, "utf8").trim(); } catch (e) {
      throw new Error(`SOLANA_RPC_FALLBACK_FILE ${file} unreadable: ${e.code || e}`);
    }
    // Vault format = BARE UUID key; a full endpoint URL is also accepted.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw)) {
      return HELIUS_DEVNET + raw;
    }
    if (!/^https:\/\/[^\s?/?&=]+\/?\?api-key=[0-9a-f-]{36}$/.test(raw)) {
      throw new Error(`SOLANA_RPC_FALLBACK_FILE ${file} is not a Helius api key or https URL with an api-key (shape ${raw.length} chars, not logged)`);
    }
    return raw;
  }
  if (!/^https:\/\//.test(url)) throw new Error("SOLANA_RPC_FALLBACK_URL must be https");
  return url;
}

async function rpc(method, params, timeoutMs = 30_000) {
  const urls = [SOLANA_RPC_URL, solanaFallbackUrl()].filter(Boolean);
  let lastErr = null;
  let last429 = null;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      // Non-JSON body (429 HTML, error page) = transport: the parse throws
      // and the loop moves to the next endpoint. A JSON-RPC error with code
      // 429 is the SAME transport condition in JSON clothing — fail over
      // too (more endpoints left); from the last endpoint it returns so the
      // caller's error wording and ladder budgets stay unchanged.
      const body = await res.json();
      if (body?.error && Number(body.error.code) === 429 && i < urls.length - 1) {
        last429 = body;
        continue;
      }
      return body;
    } catch (e) {
      lastErr = e; // transport class — next endpoint, else rethrow below
    } finally { clearTimeout(t); }
  }
  throw lastErr ?? (last429 ? new Error(`solana rpc 429 on all endpoints: ${JSON.stringify(last429.error).slice(0, 200)}`) : new Error("no solana rpc endpoint available"));
}

export async function solanaBlockhash(timeoutMs = 20_000) {
  const r = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }], timeoutMs);
  const bh = r?.result?.value?.blockhash;
  if (!bh) throw new Error(`blockhash unavailable: ${JSON.stringify(r?.error ?? r).slice(0, 200)}`);
  return bh;
}

// ---------------- Task 8.5 (2026-10-01): confirm-loop transport handling --
//
// The public devnet endpoint answers a poll burst (e.g. 8 parallel flow
// confirms ≈ 9 rps) with HTTP 429 / JSON-RPC rate-limit error bodies. That is
// TRANSPORT status — the node never answered the question — not a verdict on
// the tx, so it must never be folded into "not yet confirmed" polling (the
// Task-8 run-3 defect: instantly-delivered flows silently burned their 90s
// window under a 429 storm). Escalations are bounded: ≤5 per confirm window,
// exponential, then held at the max rung. Once the budget is exhausted the
// loop interposes DIRECT ledger-evidence probes (getTransaction meta re-read,
// whose pre/postBalances are the balance-delta verdict) so an already-landed
// tx is rescued instead of timing out. The verdict stays ledger-truth and
// fail-closed: the fallback only ADDS evidence, never upgrades a known
// failure; only when BOTH evidence channels return nothing is
// non-confirmation declared, loudly, naming both channel outcomes.
//
// SOLANA_CONFIRM_BACKOFF_MS is a test-only shim that shortens the rungs
// (comma-separated positive integers, ≤5 — malformed fails loud BEFORE any
// RPC). Production never sets it and gets TRANSPORT_BACKOFF_MS.
export const TRANSPORT_BACKOFF_MS = Object.freeze([900, 1800, 3600, 7200, 14400]);

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const jsonSnippet = (x) => String(x?.message ?? JSON.stringify(x)).slice(0, 150);

function transportRungs() {
  const raw = process.env.SOLANA_CONFIRM_BACKOFF_MS;
  if (raw === undefined || raw === "") return TRANSPORT_BACKOFF_MS;
  const arr = String(raw).split(",").map((s) => s.trim());
  if (arr.length < 1 || arr.length > TRANSPORT_BACKOFF_MS.length || arr.some((s) => !/^\d+$/.test(s) || Number(s) <= 0)) {
    throw new Error(`SOLANA_CONFIRM_BACKOFF_MS is malformed: ${raw} — want ≤${TRANSPORT_BACKOFF_MS.length} comma-separated positive integers (test shim; production never sets it)`);
  }
  return Object.freeze(arr.map(Number));
}

// ---------------- Task 8.5 round 2 (2026-10-02): send-side transport
// classification + bounded retry -------------------------------------------
//
// The run-4 live smoke lost 3/8 flows at the sendTransaction RPC itself
// ("solana send refused" — rate-limit / blockhash-expiry class), and the
// send path retried NOTHING. Mirror of the confirm-loop ruling (above),
// ONE:ONE: a sendTransaction response whose body is `r.error` (HTTP 429 with
// a JSON-RPC error body, blockhash-expiry class) or a thrown fetch (non-JSON
// 429 body, abort, network) whose text is the transport class is TRANSPORT
// status — the node never processed the send, so it is NOT a tx verdict —
// and it is retried with a bounded exponential backoff (≤3 rungs, default
// 2s/4s/8s + jitter) BEFORE the existing loud-throw line. A refused send
// never hit the chain, and an identical signed legacy tx resubmitted anyway
// dedupes by (blockhash, signature), so the retry carries zero double-send
// risk. A TX-level verdict refusal (preflight simulation failure, bad input —
// anything outside the transport class) is NEVER retried; it throws
// immediately with the verbatim text, exactly as before. After the retry
// budget is exhausted the throw is byte-identical to today's shape, and a
// thrown-fetch error keeps propagating raw (never re-wrapped).
//
// Blockhash refusals: when the refusal names a stale blockhash, the retry
// would fail again — `opts.rebuildTx` (an optional `() => Promise<string>`
// that re-fetches a fresh blockhash and re-signs the SAME payload; solanaPayout
// passes one) lets that attempt re-sign. Callers with no rebuild callback
// retry the same signed tx (still dedupe-safe); the shape of their errors is
// unchanged either way.
//
// SOLANA_SEND_BACKOFF_MS is the test-only rung shim for this loop (same
// contract as SOLANA_CONFIRM_BACKOFF_MS: comma-separated positive integers,
// ≤3 — malformed fails loud BEFORE any RPC). Production never sets it.
export const SEND_RETRY_BACKOFF_MS = Object.freeze([2000, 4000, 8000]);
const SEND_JITTER_MS = 250; // max jitter added to a rung (scaled: ≤rung/8)

// Transport refusal classes the send path retries on — rate-limit bodies,
// blockhash-expiry (incl. devnet preflight's "NOT simuable" relay note),
// throttling/overload wording. Everything else (simulation failure, program
// error, bad input) is a TX verdict and is never retried.
const TRANSPORT_REFUSAL_RE = /(429|rate ?limit|too many requests|blockhash|simuable|throttl|overloaded|temporarily unavailable|capacity)/i;

// A send "success" result must at least be a non-empty base58 signature
// string (a real Solana signature is the base58 of 64 bytes). Anything else
// — null, an object, empty text, non-base58 text — is a malformed response:
// see the F-3 guard in sendAndConfirmSolanaTx.
const B58_SHAPE_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

function sendRungs() {
  const raw = process.env.SOLANA_SEND_BACKOFF_MS;
  if (raw === undefined || raw === "") return SEND_RETRY_BACKOFF_MS;
  const arr = String(raw).split(",").map((s) => s.trim());
  if (arr.length < 1 || arr.length > SEND_RETRY_BACKOFF_MS.length || arr.some((s) => !/^\d+$/.test(s) || Number(s) <= 0)) {
    throw new Error(`SOLANA_SEND_BACKOFF_MS is malformed: ${raw} — want ≤${SEND_RETRY_BACKOFF_MS.length} comma-separated positive integers (test shim; production never sets it)`);
  }
  return Object.freeze(arr.map(Number));
}

const sendJitterMs = (rung) => crypto.randomInt(Math.min(SEND_JITTER_MS, Math.max(1, Math.ceil(rung / 8))) + 1);

/**
 * One ledger-evidence re-read of a signature's tx meta. Returns
 * `{ tx: null, out: "<why no evidence>" }` on transport failure or a null
 * result; returns the tx when found with meta.err null; THROWS fail-closed
 * when meta.err is non-null (an onchain failure is a known failure, never
 * upgraded, never retried into a success).
 */
async function readTxMeta(sig) {
  let body = null;
  try {
    body = await rpc("getTransaction", [sig, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 }], 30_000);
  } catch (e) { return { tx: null, out: `transport-unavailable (${jsonSnippet(e)})` }; }
  if (body?.error) return { tx: null, out: `transport-unavailable (${jsonSnippet(body.error)})` };
  const tx = body?.result ?? null;
  if (!tx) return { tx: null, out: "no evidence (result null)" };
  if (tx.meta?.err) throw new Error(`solana tx meta has err despite confirmed status: ${JSON.stringify(tx.meta.err)}`);
  return { tx, out: "delivered" };
}

function deliveredByAccountFrom(tx) {
  const keys = tx.transaction.message.accountKeys ?? [];
  // getTransaction (maxSupportedTransactionVersion: 0) reports meta.loadedAddresses
  // as {writable, readonly} — a `v0` key never exists. The ledger order is:
  // static account keys first, then the writable loaded addresses, then the
  // readonly loaded addresses — exactly how preBalances/postBalances are
  // laid out, so the audit is index-aligned over the FULL address set. A
  // readonly loaded account cannot receive lamports, so live ledgers report
  // it at a zero delta (no delivered entry), but the audit still sees its
  // position — nothing in the audited key order is invisible.
  const loaded = tx.meta.loadedAddresses ?? {};
  const allKeys = [
    ...keys.map((k) => (typeof k === "string" ? k : k.pubkey)),
    ...(loaded.writable ?? []),
    ...(loaded.readonly ?? []),
  ].map(String);
  const pre = tx.meta.preBalances ?? [];
  const post = tx.meta.postBalances ?? [];
  const deliveredByAccount = new Map();
  allKeys.forEach((k, i) => {
    const d = (post[i] ?? 0) - (pre[i] ?? 0);
    if (d !== 0) deliveredByAccount.set(k, d);
  });
  return deliveredByAccount;
}

/**
 * Send + confirm + re-read. Resolves ONLY on a confirmed tx whose meta.err is
 * null; anything else throws with the honest error (never a silent pass).
 * @returns {{signature, deliveredByAccount: Map<string, number>, slot}}
 *   deliveredByAccount maps base58 pubkey -> lamports delta (post − pre).
 */
export async function sendAndConfirmSolanaTx(base64Tx, { timeoutMs = 60_000, confirmMs = 90_000, rebuildTx } = {}) {
  const rungs = transportRungs(); // before ANY RPC: a malformed test-shim env refuses loud here
  const sendRungList = sendRungs(); // same contract for the send-retry shim, also before any RPC
  let sig = null;
  let sendRungIdx = 0; // attempted transport rungs; ≤sendRungList.length per send
  // A body that carries NEITHER an error nor a real signature string in
  // `result` (final-review F-3, 2026-10-02) is a malformed transport
  // response, NOT evidence of a send: it is classified the SAME way the loop
  // classifies a transport refusal (retried under the same bounded budget;
  // the garbage value never enters the confirm loop as a sig). On budget
  // exhaustion the throw below is loud and names the offending shape.
  let shapeRefusal = null;
  // Send attempts: 1 initial + ≤3 bounded transport retries. A refusal is a
  // transport event (rate-limit body, non-JSON 429, blockhash-expiry class)
  // classified the SAME way the confirm loop classifies transport — a
  // refused send never hit the chain, and an identical signed tx dedupes by
  // signature on resubmission, so retrying carries no double-send risk.
  for (;;) {
    let body = null;
    let tErr = null;
    shapeRefusal = null;
    try { body = await rpc("sendTransaction", [base64Tx, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" }], timeoutMs); }
    catch (e) { tErr = e; }
    if (!tErr && !body?.error) {
      const r = body?.result;
      if (typeof r === "string" && r.length > 0 && B58_SHAPE_RE.test(r)) { sig = r; break; }
      shapeRefusal = `sendTransaction replied "success" whose result is not a non-empty base58 signature string (${typeof r}: ${JSON.stringify(r ?? null)})`;
    }
    const text = tErr !== null
      ? String(tErr?.message ?? tErr).slice(0, 200)
      : (shapeRefusal ?? String(body.error?.message ?? JSON.stringify(body.error).slice(0, 200)));
    // TX-verdict refusals (preflight simulation failure, bad input) are
    // never retried; the class below is transport only.
    const blockhashClass = /blockhash/i.test(text);
    const transport = tErr !== null || shapeRefusal !== null || (!!body?.error && TRANSPORT_REFUSAL_RE.test(text));
    if (transport && sendRungIdx < sendRungList.length) {
      if (blockhashClass && typeof rebuildTx === "function") {
        base64Tx = await rebuildTx(); // a stale blockhash is why the retry would fail again — re-fetch + re-sign
      }
      await sleepMs(sendRungList[sendRungIdx] + sendJitterMs(sendRungList[sendRungIdx]));
      sendRungIdx++;
      continue;
    }
    if (shapeRefusal !== null) throw new Error(`solana send malformed result: ${shapeRefusal}`); // loud, names the shape
    if (tErr !== null) throw tErr; // shape parity: a thrown fetch propagates raw, as today
    throw new Error(`solana send refused: ${text}`); // shape parity: today's loud throw, verbatim refusal
  }
  const deadline = Date.now() + confirmMs;
  let confirmed = false;   // broke on a definitive confirmed/finalized status
  let landedMeta = null;   // direct ledger-evidence probe already found the tx
  let transportRetries = 0; // bounded: ≤rungs.length escalations per window
  for (;;) {
    let body = null;
    let tErr = null;
    try { body = await rpc("getSignatureStatuses", [[sig]], 20_000); }
    catch (e) { tErr = e; }
    const st = body?.result?.value?.[0];
    // transport-unavailable: a thrown fetch (non-JSON 429 body) or a JSON-RPC
    // error body — the node never answered, so this is NOT evidence either
    // way and must never count as a "not yet confirmed" poll.
    const transport = tErr !== null || !!body?.error;
    if (!transport && st) {
      if (st.err) throw new Error(`solana tx failed onchain: ${JSON.stringify(st.err).slice(0, 300)}`);
      if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") { confirmed = true; break; }
    }
    if (transport) {
      transportRetries += 1;
      // Once the bounded escalation budget is exhausted, interpose ONE direct
      // ledger-evidence probe per cycle — under the run-3 429 storm a flow
      // that landed in ~1s is rescued here at ~28s instead of timing out at
      // 90s. Verdicts stay ledger-truth: meta.err anywhere throws onchain.
      if (transportRetries >= rungs.length) {
        const probe = await readTxMeta(sig);
        if (probe.tx) { landedMeta = probe.tx; break; }
      }
      if (Date.now() > deadline) break;
      await sleepMs(rungs[Math.min(transportRetries, rungs.length) - 1]);
      continue;
    }
    // Genuine "not yet confirmed" — the success-path cadence, unchanged.
    if (Date.now() > deadline) break;
    await sleepMs(900);
  }
  if (!confirmed && !landedMeta) {
    // The window exhausted without a definitive status (transport storm, or
    // genuine lag). Evidence fallback BEFORE declaring a timeout — two
    // channels, both bounded; only if BOTH return no evidence is this a
    // non-confirmation. Neither channel can upgrade a known failure: any
    // onchain err found throws fail-closed below.
    let aOut = "no evidence (result null)";
    let aConfirmed = false;
    try {
      const a = await rpc("getSignatureStatuses", [[sig], { searchTransactionHistory: true }], 20_000);
      if (a?.error) aOut = `transport-unavailable (${jsonSnippet(a.error)})`;
      else {
        const ast = a?.result?.value?.[0];
        if (!ast) aOut = "no evidence (result null)";
        else if (ast.err) throw new Error(`solana tx failed onchain: ${JSON.stringify(ast.err).slice(0, 300)}`);
        else if (ast.confirmationStatus === "confirmed" || ast.confirmationStatus === "finalized") aConfirmed = true;
        else aOut = `no evidence (status ${String(ast.confirmationStatus ?? "absent")})`;
      }
    } catch (e) {
      if (String(e?.message ?? "").startsWith("solana tx ")) throw e; // known onchain failure — rethrow, never upgraded
      aOut = `transport-unavailable (${jsonSnippet(e)})`;
    }
    if (aConfirmed) confirmed = true;
    else {
      const b = await readTxMeta(sig);
      if (!b.tx) {
        throw new Error(`solana tx not confirmed within ${confirmMs}ms: ${sig} — evidence fallback exhausted (channel A status-history: ${aOut}; channel B tx-meta: ${b.out})`);
      }
      landedMeta = b.tx;
    }
  }
  // Meta for the delivered-amount audit (balance deltas). On the plain
  // confirmed-status path this is the original re-read; on the evidence path
  // the probe already holds it (no duplicate read). Devnet indexing lags the
  // confirmation signal — re-read with backoff before giving up.
  let tx = landedMeta;
  if (!tx) {
    // Devnet indexing has hit >12s lag live (2026-10-06 desk legs) — 15×3s.
    for (let i = 0; i < 15; i++) {
      tx = (await rpc("getTransaction", [sig, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 }], 30_000))?.result;
      if (tx) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!tx) throw new Error(`solana tx confirmed but meta re-read failed: ${sig}`);
    if (tx.meta?.err) throw new Error(`solana tx meta has err despite confirmed status: ${JSON.stringify(tx.meta.err)}`);
  }
  const deliveredByAccount = deliveredByAccountFrom(tx);
  return { signature: sig, deliveredByAccount, slot: tx.slot, blockTime: tx.blockTime };
}

/** One-shot custodian payout: System transfer + SPL Memo v2 in the same tx. */
export async function solanaPayout({ custodianPath, toPubkey, lamports, memo, extraSigners = [] }) {
  const custodian = loadKeypair(custodianPath);
  if (!b58decode(toPubkey) || b58decode(toPubkey).length !== 32) throw new Error("bad destination pubkey");
  if (!Number.isSafeInteger(lamports) || lamports <= 0) throw new Error("lamports must be a positive safe integer");
  const MEMO_V2 = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"; // live-verified 2026-09-18
  const SYSTEM = "11111111111111111111111111111111";
  const blockhash0 = await solanaBlockhash();
  const lamportsLe = Buffer.alloc(8);
  lamportsLe.writeBigUInt64LE(BigInt(lamports));
  const build = (blockhash) => signSolanaTx({
    payer: custodian, blockhash, extraSigners, // keys already in-process here — re-signing needs no re-read
    instructions: [
      { programId: MEMO_V2, keys: [], data: Buffer.from(memo, "utf8") },
      { programId: SYSTEM, keys: [
        { pubkey: custodian.pubkey, isSigner: true, isWritable: true },
        { pubkey: toPubkey, isSigner: false, isWritable: true },
      ], data: Buffer.concat([Buffer.from([2, 0, 0, 0]), lamportsLe]) },
    ],
  });
  const r = await sendAndConfirmSolanaTx(await build(blockhash0), {
    // Blockhash-expiry refusals must retry against a FRESH blockhash — the
    // retry re-fetches it and re-signs the same payout. A refused send never
    // hit the chain (and a resubmitted identical tx dedupes by signature):
    // zero double-send risk.
    rebuildTx: async () => build(await solanaBlockhash()),
  });
  const delivered = r.deliveredByAccount.get(toPubkey);
  if (delivered !== lamports) {
    throw new Error(`custodian payout delivered ${delivered} lamports, wanted ${lamports} — refusing to report success`);
  }
  return { signature: r.signature, rail: RAIL, from: custodian.pubkey, to: toPubkey, delivered, memo, slot: r.slot };
}
// ================= Token-2022 extension (fx-terminal, 2026-10-06) =================
// Ported from ata.mjs / escrow-server/solana-evidence.mjs conventions. NO
// @solana/web3.js anywhere in the estate's app path (operator ruling — the
// handrolled stack is proven live on R13.1–R13.3, devnet transferChecked +
// memo-v2 ids live-verified 2026-09-18).

export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const MEMO_V2_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/** SPL Token / Token-2022 transferChecked (ix tag 12):
 *  data = [12] + u64LE(amount) + [decimals];
 *  accounts = [source(w), mint(r), destination(w), authority(signer, r)]. */
export function buildTransferCheckedIx({ source, mint, destination, authority, amount, decimals }) {
  const amountLe = Buffer.alloc(8);
  amountLe.writeBigUInt64LE(BigInt(amount));
  return {
    programId: TOKEN_2022_PROGRAM,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([12]), amountLe, Buffer.from([decimals])]),
  };
}

/** SPL Memo v2: no accounts, data = utf8 memo. Authority listed as a signer so
 *  the tx signature covers the memo ordering without new writable keys. */
export function buildMemoV2Ix(memoText, authority) {
  return {
    programId: MEMO_V2_PROGRAM,
    keys: authority ? [{ pubkey: authority, isSigner: true, isWritable: false }] : [],
    data: Buffer.from(memoText, "utf8"),
  };
}

/** Task-8.5 principle extended to the preflight readers (2026-10-06): a
 *  rate-limited / unreachable RPC answers NOTHING — it carries a JSON-RPC
 *  error body, a non-JSON body (devnet 403 text), or times out, and must
 *  never be folded into an on-chain verdict ("mint not found"). One bounded
 *  retry at the first transport rung, then a loud transport error naming the
 *  real cause. Only a clean `{result:{value:null}}` is the honest ABSENT
 *  verdict — same class of defect the confirm loop hit (Transport-429 storms
 *  misreported as chain outcomes). */
async function accountInfoValue(kind, base58Address) {
  let transportErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleepMs(TRANSPORT_BACKOFF_MS[0]);
    let r;
    try {
      r = await rpc("getAccountInfo", [base58Address, { encoding: "base64" }]);
    } catch (e) {
      transportErr = e; // non-JSON body / network error / abort
      continue;
    }
    if (r?.error || r?.result === undefined) {
      transportErr = r?.error ?? r;
      continue;
    }
    return r.result.value; // null = genuinely absent — an on-chain verdict
  }
  throw new Error(
    `${kind} ${base58Address} UNVERIFIABLE — devnet transport failed (no chain verdict): ${jsonSnippet(transportErr)}`
  );
}

/** Token ACCOUNT layout: mint(0:32) owner(32:64) amount u64 LE (64:72). */
export async function tokenAccountAmount(base58Account) {
  const info = await accountInfoValue("token account", base58Account);
  if (!info) throw new Error(`token account ${base58Account} not found on-chain`);
  return Buffer.from(info.data[0], "base64").readBigUInt64LE(64);
}

/** MINT layout: decimals is byte 44 (mintAuthorityOption u32 + authority 32 + supply u64). */
export async function mintDecimals(base58Mint) {
  const info = await accountInfoValue("mint", base58Mint);
  if (!info) throw new Error(`mint ${base58Mint} not found on-chain`);
  return Buffer.from(info.data[0], "base64").readUInt8(44);
}

/** Signature status (null while the RPC indexes); err must fail closed upstream. */
export async function sigStatus(base58Sig) {
  const r = await rpc("getSignatureStatuses", [[base58Sig], { searchTransactionHistory: true }]);
  return r?.result?.value?.[0] ?? null; // { slot, confirmations, confirmationStatus, err } | null
}

/** Raw JSON-RPC passthrough for evidence readers (getTransaction meta parsing).
 *  Same endpoint ladder as the tx path: public devnet primary, Helius fallback
 *  per transport class. Exported for the R13-consumers pattern; never exposes
 *  the composed fallback URL to callers. */
export { rpc as solanaRpc };
