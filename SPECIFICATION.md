# Formal Technical Specification: syn-stripe-bridge

**Specification ID:** SYN-SPEC-2026-021-R2
**Title:** Sovereign Stripe v1 API Emulator over Solana Token-2022 devnet & ISO 20022 Clearing
**Author:** Abdul Shabazz (`veritasvaultone@gmail.com`)
**Status:** Devnet honest core — offline suite 17/17, live smoke custody-gated
**Date:** October 8, 2026

---

## 0. v0.1 defects this rewrite closes

v0.1 of this bridge (SHA `ee7a2ec6…`) claimed "Implemented & Verified" while its
settlement core was mock-driven. The v0.2 rewrite is the honest core; each
defect below is closed by code + test, not by prose:

| # | v0.1 defect | v0.2 closure (receipt) |
|---|---|---|
| F1 | settlement always returned `Acsc` unconditionally — success was fabricated | pacs.002 `Acsc` exists ONLY inside a passed delivered-delta gate (`tests/test_stripe_shim.mjs` → "pacs.002 Acsc carries rail evidence") |
| F2 | plain `SPL Token` transfer, no Token-2022 | `buildTransferCheckedIx` under `TOKEN_2022` program, decimals 6 (vendored, live-proven) |
| F3 | USD→lamports conversion invented an fx rate | **1 cent = 10,000 raw OUSD units** (decimals 6); no fx anywhere |
| F4 | default recipient `4uQeVj…` + ephemeral boot keypair | `recipient_required` / `recipient_invalid` 400s; custody key ONLY by path (`bridge_boot_refused: BRIDGE_CUSTODY_KEY_FILE is required`) |
| F5 | no authentication | fail-closed bearer (sha256 + `timingSafeEqual`) on every `/v1/*` |
| F6 | no preflight before dispatch | ISO parties resolve (400) → merchant balance (402) → custody OUSD (402 `bridge_custody_unfunded`) → custody SOL — all VERBATIM before any build |
| F7 | pacs.002 string-only, webhook never delivered | pacs.002 emitted from the gate-passed settlement; webhook POSTed with HMAC `stripe-signature: t=…,v1=…`, ×3 attempts recorded |
| F8 | fabricated pacs.008 bank defaults | `buildPacs008` requires every party (`requireField` refusals); confirm refuses `iso20022_fields_missing` with the missing list |
| F9 | dangerous defaults (`amount ‖ 1000`, in-memory store) | zero defaults + append-only `receipts.jsonl` (`O_EXCL`), replayed on boot (live-verified across restarts) |

---

## 1. Scope & Objective

This specification codifies the invariants, wire protocol mappings, and
exact-once guarantees of `syn-stripe-bridge` (`:8092`). It implements a
drop-in Stripe v1 `PaymentIntent` REST surface on **Solana devnet** that
translates incoming calls into:

1. A **chain-evidenced merchant prepaid balance** (deposits verified from real
   ledger transactions, single-use by signature, memo `X402:<merchant_id>`).
2. **pacs.008.001.08** wire synthesis, 14-point CBPR+ validated **before** dispatch.
3. One **Token-2022 `transferChecked`** settlement leg (custody ATA → recipient
   ATA) with SPL Memo v2 carrying the **SSOT `X402P:` frame** (UETR-bound).
4. A **delivered-delta gate** — the only path to success.
5. **pacs.002.001.12** (`<TxSts>Acsc</TxSts>`) + HMAC-signed Stripe-shaped webhook
   — only after the gate.

**Not implemented (honestly):** multi-currency settlement (v0.2 is `usd` →
devnet OUSD), the TSA levy rail (`tsa_bps` ≠ 0 ⇒ `levy_not_configured`),
chargebacks/disputes (irreversible design), payment methods (prepaid model).

## 2. Stripe ↔ Rail State Machine (as implemented)

| Stripe-style state | Transition | Rail truth |
| :--- | :--- | :--- |
| `requires_confirmation` | `POST /v1/payment_intents` (JSON or form-encoded) | idempotency-key honored; nothing leaves the process |
| `requires_confirmation` (stays) | confirm with missing ISO parties | 400 `iso20022_fields_missing` — malformed before readiness, no rail action |
| `processing` | confirm accepted | dispatch queued (serialized), preflight passed |
| `processing` (verify-on-read) | confirm timed out at 15s (200 + 202) | `GET` re-reads: `tryVerifyOnRead` completes only on a passed gate; meta re-read failure ⇒ never re-sends |
| `succeeded` | confirmed + **delivered-delta gate passed** | pacs.002 `Acsc`, webhook, ledger debit row |
| `settlement_broken` | confirmed but gate failed | 500; no debit, no pacs.002; ledger `settlement_broken` row; **never auto-retried** |

There are no `requires_payment_method` / `requires_action` states: the model is
prepaid balance, not payment methods.

## 3. Money invariant

**1 cent = 10,000 raw OUSD units** (`RAW_UNITS_PER_CENT = 10_000`, decimals 6,
mint `2ANrmtAcMd8eihFGvbyAkrAWveq8nU6uMTigbWBuigNe` — the estate **devnet**
OUSD). No conversion, no oracle, no fx — v0.2 settles the unit it demonstrates.

Custody conservation: every debit is preceded by one verified credit;
`Σ deposits(verified) − Σ settlements(gate-passed) = merchant prepaid balance`
must hold at all times (the ledger replay reconstructs exactly this).

## 4. Wire assembly invariant

```
Transaction = [ ComputeBudget(CU-limit), (ATokenGP CreateIdempotent if dest ATA absent),
                SPL Memo v2(SSOT frame), Token-2022 transferChecked ]
```

- The memo is built **only** by `vendor/discriminators.mjs#buildDeskSettlementMemo`
  (SSOT `discriminators.mjs` — the estate's byte-exact 14-tag grammar). Hand-written
  memos are a defect by construction; the SSOT round-trip is regression-tested.
- Token-2022 `RequiredMemoTransfers` is a **rail assumption** documented in
  PAPER_1 (netting paper §68), not an enforcement the bridge installs.
- If the destination ATA is absent, `ATokenGP create idempotent` is inserted —
  presence is re-checked pre-dispatch; a stale read fails the gate, never the
  accounting.

## 5. CBPR+ validation (14 structural rules — unchanged contract)

Messages validate before dispatch on the same 14 rules as v0.1 (namespace,
group header, message-id ≤35, `NbOfTxs == 1`, settlement method, `CdtTrfTxInf`,
end-to-end reference, RFC 4122 UETR, ISO 4217 currency, positive amount,
debtor BIC, creditor BIC, charge bearer enum, document close). v0.2 additionally
**refuses to build** any party-less wire (F8): every party field is required
with a named `requireField` refusal, and a validation failure is a 500
`cbpr_build_rejected` — no fallback wire is ever constructed.

## 6. Exact-once architecture

1. **Deposits**: single-use by signature. The live path adds the signature to
   the used-set **before** the credit; boot replay rebuilds both the credit and
   the used-set from `receipts.jsonl` (test: "deposit replay ⇒ 409 … after reboot").
2. **Settlements**: single-use by UETR (regeneration throws); idempotency-key
   replays return the ORIGINAL response body unchanged.
3. **Ledger**: append-only JSONL created `O_EXCL`; torn trailing lines are
   skipped on replay; `kind ∈ {deposit, intent, settlement, settlement_broken}`.
4. **Confirm window**: 15s budget with blockhash rebuild + per-call transport
   ladder (public devnet primary, Helius devnet fallback — vault-sourced, per
   call). Beyond the window: `202 processing` + verify-on-read, never a silent
   re-send.

## 7. Webhook security (v0.1 §5 preserved, now actually delivered)

The bridge POSTs a Stripe-shaped `payment_intent.succeeded` event with:

```
Stripe-Signature: t=<unix>,v1=HMAC-SHA256(webhook_secret, t + "." + payload)
```

HMAC uses the merchant's `webhook_secret` (registry field, plaintext — the
registry is 0600); bearer keys are stored as sha256 digests only. Delivery is
attempted up to 3× and each attempt (status/error) is recorded on the intent;
a delivered webhook is evidence, an undelivered one is recorded as such —
the settlement is not blocked by receiver-side availability.

## 8. Verification surface

| Gate | Where it lives | Command |
|---|---|---|
| Offline structural suite (mock Solana RPC, real wire fixtures) | `tests/` | `npm test` → 17/17 green |
| Live devnet smoke — health + custody gate (moves nothing) | `scripts/smoke_devnet.mjs` | exits 0 with `SMOKE SKIPPED (custody unfunded)` |
| Live devnet smoke — the ONE real settlement | same, `SMOKE_CONFIRM=1` | operator-gated (explicit funding + explicit go) |
| Provisioning of REAL fixtures (no mock addresses) | `scripts/provision_smoke.mjs` | writes 0600 vault files, prints only public keys |

The suite pins: boot identity incl. **mainnet-mint boot refusal**, fail-closed
auth, all no-default refusals, ISO-400-before-402 ordering, both unfunded 402s,
wrong-memo deposit refusal, chain-verified credit + single-use replay (incl.
across reboot), errored-tx non-evidence, idempotency, ledger replay, and the
SSOT memo round-trip.