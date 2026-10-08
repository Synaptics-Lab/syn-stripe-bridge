// ata.mjs — PURE Solana address derivation helpers for the Token-2022 netting
// legs (CAN v2 regression-B). No keys, no network: only the standard PDA
// algorithm and the ATA convention, implemented byte-exactly so the estate
// composes wire bytes WITHOUT @solana/web3.js (same discipline as
// solana-ptb.mjs).
//
//   - findProgramAddressSync: sha256(seeds… || [nonce] || programId), nonce
//     255 → 0, first hash NOT on the ed25519 curve is the PDA (the exact
//     runtime algorithm, pubkey_find_program_address).
//   - On-curve check via @noble/curves ed25519.Point.fromBytes (a point
//     decompresses ⟺ the 32 bytes are on the curve), from the ESCROW's pinned
//     node_modules (the same copy the estate's live verifier runs).
//   - ATA (Associated Token Account) = findProgramAddressSync([owner,
//     tokenProgram, mint], tokenProgram) — the documented derivation the
//     ATokenGP program funds at (the create-at ix program id below is the
//     ASSOCIATED_TOKEN_PROGRAM_ID, NOT the derivation program id).
import { createHash } from "node:crypto";
import { ed25519 } from "./vendor-noble/node_modules/@noble/curves/ed25519.js";
import { b58decode, b58encode } from "./solana-tx.mjs";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // classic SPL Token (System legs era)
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"; // live-verified R16 (r16-solana-lanes-stage2.mjs)
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"; // Create/CreateIdempotent ix program
export const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

const onCurve = (b32) => {
  try { ed25519.Point.fromBytes(b32); return true; } catch { return false; }
};

const pub32 = (b58, name) => {
  const raw = b58decode(String(b58));
  if (!raw || raw.length !== 32) throw new Error(`${name}: bad pubkey (want base58 32 bytes)`);
  return Buffer.from(raw);
};

/**
 * findProgramAddressSync — the runtime algorithm, byte-exact: hash
 * sha256(seed1 || seed2 || … || [nonce] || programId) with nonce 255 → 0 and
 * return the FIRST bytes that do NOT sit on the ed25519 curve (a PDA is an
 * unverifiable point). Refuses loud when no nonce resolves (never a silent
 * truncation — that would be a wrong address by construction).
 */
export function findProgramAddressSyncPda(seeds, programIdB58) {
  const program = pub32(programIdB58, "programId");
  const parts = seeds.map((s) => {
    const b = Buffer.isBuffer(s) ? s : String(s).startsWith("syn1") ? null : Buffer.from(String(s), "utf8");
    if (Buffer.isBuffer(b)) return b;
    // base58 32-byte seeds (pubkey seeds) are decoded by the caller passing
    // Buffers — this module keeps its convention: pass Buffers for pubkeys.
    return Buffer.from(String(s), "utf8");
  });
  if (parts.length > 255) throw new Error("findProgramAddressSyncPda: too many seeds (runtime cap 255)");
  for (let nonce = 255; nonce >= 0; nonce--) {
    // Byte-exact runtime PDA algorithm: the hash input carries the literal
    // ASCII suffix "ProgramDerivedAddress" AFTER the program id (missing it
    // hashes to a wrong-but-plausible address; web3.js source + live devnet
    // refused mint settled it — 2026-10-07).
    const hash = createHash("sha256")
      .update(Buffer.concat([...parts, Buffer.from([nonce]), program, Buffer.from("ProgramDerivedAddress")]))
      .digest();
    if (!onCurve(hash)) return { address: b58encode(hash), nonce };
  }
  throw new Error("findProgramAddressSyncPda: unable to find a viable program address nonce (255..0 exhausted)");
}

/** The Associated Token Account: PDA [owner ‖ tokenProgram ‖ mint] under the ATA PROGRAM (ATokenGP…knL) — not under the token program. */
export function deriveAssociatedTokenAddress(ownerB58, tokenProgramB58, mintB58) {
  const owner = pub32(ownerB58, "owner");
  const mint = pub32(mintB58, "mint");
  const prog = pub32(tokenProgramB58, "tokenProgram");
  return findProgramAddressSyncPda([owner, prog, mint], ATA_PROGRAM).address;
}

/** SetComputeUnitLimit instruction bytes (ComputeBudget disc 2 + u32 LE units). */
export function setComputeUnitLimitData(units) {
  if (!Number.isSafeInteger(units) || units <= 0 || units > 1.4e6) {
    throw new Error(`setComputeUnitLimit units ${units} outside the devnet netting range (1..1,400,000) — refused (the R16 stage-2 CU gotcha)`);
  }
  const d = Buffer.alloc(5);
  d[0] = 2;
  d.writeUInt32LE(units, 1);
  return d;
}

/** ATokenGP CreateIdempotent ix data (disc 1) — create-and-fund-if-missing. */
export function createIdempotentData() {
  return Buffer.from([1]);
}

/** ATokenGP CreateIdempotent ACCOUNT ORDER (canonical, web3.js ground truth 2026-10-07):
 *  6 accounts [payer(s+w), ata(w), wallet(ro), mint(ro), system(ro), token program(ro)];
 *  the old 7-account order tokenized token-program/mint swapped with a rent sysvar
 *  the program no longer expects — never run live, caught in the blast-radius audit. */
export function createIdempotentAccounts({ payerPubkey, ataB58, walletB58, tokenProgramB58, mintB58 }) {
  return [
    { pubkey: payerPubkey, isSigner: true, isWritable: true },
    { pubkey: ataB58, isSigner: false, isWritable: true },
    { pubkey: walletB58, isSigner: false, isWritable: false },
    { pubkey: mintB58, isSigner: false, isWritable: false },
    { pubkey: "11111111111111111111111111111111", isSigner: false, isWritable: false },
    { pubkey: tokenProgramB58, isSigner: false, isWritable: false },
  ];
}