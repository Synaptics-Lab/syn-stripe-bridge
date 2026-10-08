#!/usr/bin/env node
/**
 * provision_smoke.mjs — one-time provisioning of REAL (never mock) fixtures
 * for the syn-stripe-bridge devnet smoke and pm2 service.
 *
 * Writes to the estate vault, 0600, paths only:
 *   /opt/synapticchain/keys/devnet-test/syn-stripe-bridge-custody.key   (64-int solana keypair)
 *   /opt/synapticchain/keys/devnet-test/syn-stripe-bridge-merchants.json (bearer HASHES only)
 *   /opt/synapticchain/keys/devnet-test/syn-stripe-bridge-bearer.env     (plaintext bearer, 0600)
 *
 * Prints ONLY public material (custody pubkey, custody ATA). Idempotent:
 * re-runs reuse an existing custody key.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

const VAULT = "/opt/synapticchain/keys/devnet-test";
const CUSTODY_FILE = path.join(VAULT, "syn-stripe-bridge-custody.key");
const MERCHANTS_FILE = path.join(VAULT, "syn-stripe-bridge-merchants.json");
const BEARER_FILE = path.join(VAULT, "syn-stripe-bridge-bearer.env");

const repoRoot = path.resolve(new URL(".", import.meta.url).pathname, "..");
const { ed25519 } = await import(path.join(repoRoot, "vendor/vendor-noble/node_modules/@noble/curves/ed25519.js"));
const { b58encode, b58decode } = await import(path.join(repoRoot, "vendor/solana-tx.mjs"));
const { deriveAssociatedTokenAddress, TOKEN_2022 } = await import(path.join(repoRoot, "vendor/ata.mjs"));
const { OUSD_DEVNET_MINT } = await import(path.join(repoRoot, "src/stripe_shim.mjs"));

fs.mkdirSync(VAULT, { recursive: true, mode: 0o700 });

// -- custody keypair: reuse if present (keys are never regenerated) ----------
let custodySeed;
try {
    const existing = JSON.parse(fs.readFileSync(CUSTODY_FILE, "utf8"));
    custodySeed = Uint8Array.from(existing.slice(0, 32));
    console.log(`[provision] custody key already exists: ${CUSTODY_FILE} (reused)`);
} catch {
    custodySeed = randomBytes(32);
    const pub = Buffer.from(ed25519.getPublicKey(custodySeed));
    const kp64 = [...custodySeed, ...pub];
    fs.writeFileSync(CUSTODY_FILE, JSON.stringify(kp64) + "\n", { mode: 0o600 });
    console.log(`[provision] NEW custody key: ${CUSTODY_FILE}`);
}
const custodyPubB58 = b58encode(Buffer.from(ed25519.getPublicKey(custodySeed)));
const custodyAta = deriveAssociatedTokenAddress(custodyPubB58, TOKEN_2022, OUSD_DEVNET_MINT);
console.log(`[provision] custody pubkey:   ${custodyPubB58}`);
console.log(`[provision] custody OUSD ATA: ${custodyAta}  (mint ${OUSD_DEVNET_MINT})`);
console.log("[provision] >> fund: SOL lamports for fees + OUSD (Token-2022) deposits into the ATA above.");

// -- merchant registry + bearer ----------------------------------------------
let BEARER;
try {
    BEARER = fs.readFileSync(BEARER_FILE, "utf8").match(/SMOKE_BEARER=(\S+)/)?.[1];
    console.log(`[provision] bearer already exists: ${BEARER_FILE} (reused)`);
} catch {
    BEARER = `sk_bridge_${randomBytes(24).toString("hex")}`;
}
if (!BEARER) {
    console.error("[provision] FAILED: bearer file unreadable");
    process.exit(1);
}
const bearerHash = createHash("sha256").update(BEARER).digest("hex");

try {
    JSON.parse(fs.readFileSync(MERCHANTS_FILE, "utf8"));
    console.log(`[provision] merchant registry already exists: ${MERCHANTS_FILE} (reused)`);
} catch {
    const registry = [{
        id: "pilot",
        name: "Stripe Bridge Pilot Merchant",
        bearer_hash: bearerHash,
        institution_bic: "SYNAUS33XXX",
        institution_name: "Synaptic Bridge Custody Desk",
        webhook_url: "http://127.0.0.1:8900/hooks/bridge",
        webhook_secret: `whsec_${randomBytes(12).toString("hex")}`,
    }];
    fs.writeFileSync(MERCHANTS_FILE, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
    console.log(`[provision] merchant registry: ${MERCHANTS_FILE} (merchant id 'pilot')`);
}

fs.writeFileSync(BEARER_FILE, `SMOKE_BEARER=${BEARER}\n`, { mode: 0o600 });
fs.chmodSync(CUSTODY_FILE, 0o600);
fs.chmodSync(MERCHANTS_FILE, 0o600);
fs.chmodSync(BEARER_FILE, 0o600);
console.log("[provision] bearer stored 0600 at:", BEARER_FILE);
console.log("[provision] DONE — run the smoke with:");
console.log(`  set -a; source ${BEARER_FILE}; set +a; \\`);
console.log("  BRIDGE_CUSTODY_KEY_FILE=" + CUSTODY_FILE + " \\");
console.log("  BRIDGE_MERCHANTS_FILE=" + MERCHANTS_FILE + " \\");
console.log("  node scripts/smoke_devnet.mjs");