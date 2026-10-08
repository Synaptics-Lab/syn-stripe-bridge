#!/usr/bin/env node
/**
 * send_deposit.mjs — build and send ONE real merchant deposit on the bridge's
 * rail (Solana devnet, Token-2022 transferChecked + SPL Memo v2).
 *
 * This is the operator's tool for putting a REAL evidenced prefund into the
 * bridge: the tx is exactly the shape `verifyDeposit` accepts (transferChecked
 * into the custody ATA, memo `X402:<merchant_id>`), assembled with the same
 * vendored SSOT stack the bridge itself settles with — wire budget, memo,
 * transferChecked — nothing hand-written, nothing mocked.
 *
 * Usage (no dangerous defaults — every argument is explicit):
 *
 *   node scripts/send_deposit.mjs <payer.key> <custodyAta> <merchantId> <ousdDecimal>
 *
 *   payer.key     0600 solana CLI keypair file, 64-int JSON — read BY PATH,
 *                 seed never printed
 *   custodyAta    destination token account (the bridge's custody ATA)
 *   merchantId    registered merchant id; memo becomes X402:<merchantId>
 *   ousdDecimal   decimal OUSD amount (e.g. 1000 = 1000 OUSD = 1_000_000_000 raw)
 *
 * Prints only public material (signature, addresses, raw units).
 *
 * Env: SOLANA_RPC_URL (vendored default devnet + Helius devnet fallback law).
 */
import fs from "node:fs";

const [, , payerFile, custodyAta, merchantId, amountStr] = process.argv;
if (!payerFile || !custodyAta || !merchantId || !amountStr) {
  console.error('{"error":"usage: send_deposit.mjs <payer.key> <custodyAta> <merchantId> <ousdDecimal>"}');
  process.exit(1);
}
if (!fs.existsSync(payerFile)) {
  console.error(`{"error":"payer_key_file_missing: ${payerFile}"}`);
  process.exit(1);
}

const OUSD_DECIMALS = 6; // the estate devnet asset's wire decimals (fixed by issuance)
const parts = String(amountStr).split(".");
if (parts.length > 2 || (parts[1] || "").length > OUSD_DECIMALS) {
  console.error(`{"error":"amount_precision_invalid: ${amountStr}"}`);
  process.exit(1);
}
const frac = ((parts[1] || "") + "0".repeat(OUSD_DECIMALS)).slice(0, OUSD_DECIMALS);
const raw = BigInt(parts[0]) * 10n ** BigInt(OUSD_DECIMALS) + BigInt(frac);
if (raw <= 0n) {
  console.error('{"error":"amount_must_be_positive"}');
  process.exit(1);
}

const {
  loadKeypair, signSolanaTx, solanaBlockhash, sendAndConfirmSolanaTx,
  buildTransferCheckedIx, buildMemoV2Ix, b58encode, solanaRpc,
} = await import("../vendor/solana-tx.mjs");
const {
  COMPUTE_BUDGET, setComputeUnitLimitData, deriveAssociatedTokenAddress: deriveAta, TOKEN_2022,
} = await import("../vendor/ata.mjs");
const computeBudgetIx = () => ({
  programId: COMPUTE_BUDGET, keys: [], data: setComputeUnitLimitData(150_000),
});

// Rail identity is mint-bound, not name-bound: read the custody ATA's mint
// from the wire (jsonParsed, same idiom as token-evidence.mjs) so a deposit
// can never be sent on the wrong asset class. NOTE: solanaRpc is a
// passthrough — the FULL JSON-RPC body comes back (results sit under
// .result / .result.value — the envelope gotcha live-caught twice here).
const body = await solanaRpc("getAccountInfo", [custodyAta, { encoding: "jsonParsed" }]);
const accInfo = body?.result?.value;
if (!accInfo) {
  console.error('{"error":"custody_ata_absent"}');
  process.exit(1);
}
const parsedMint = accInfo?.data?.parsed?.info?.mint;
if (accInfo?.owner !== TOKEN_2022 || !parsedMint) {
  console.error(JSON.stringify({ error: "custody_ata_not_token2022", ata_owner: accInfo?.owner ?? null }));
  process.exit(1);
}
const mint = parsedMint;
const custodyOwner = accInfo?.data?.parsed?.info?.owner ?? null;

const payer = loadKeypair(payerFile);
const sourceAta = deriveAta(payer.pubkey, TOKEN_2022, mint);
const memo = `X402:${merchantId}`;

const blockhash = await solanaBlockhash();
const signed = signSolanaTx({
  payer: { seed: payer.seed, pubkey: payer.pubkey },
  blockhash,
  instructions: [
    computeBudgetIx(),
    buildMemoV2Ix(memo, payer.pubkey),
    buildTransferCheckedIx({
      source: sourceAta,
      mint,
      destination: custodyAta,
      authority: payer.pubkey,
      amount: raw,
      decimals: OUSD_DECIMALS,
    }),
  ],
});

const sent = await sendAndConfirmSolanaTx(signed);
const sig = sent?.signature ?? sent?.sig ?? sent;
process.stdout.write(JSON.stringify({
  deposit_signature: String(sig),
  memo, raw: raw.toString(),
  from: payer.pubkey, custody_ata: custodyAta, custody_owner: custodyOwner,
  source_ata: sourceAta, mint,
}) + "\n");