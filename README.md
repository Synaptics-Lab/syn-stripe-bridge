# syn-stripe-bridge

> **The Sovereign "MinIO / Ollama" for Payments — A 100% Drop-In Stripe v1 REST API Emulator on Solana Token-2022 & ISO 20022 Clearing**

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Solana Token-2022](https://img.shields.io/badge/Solana-Token--2022%20MemoTransfer-purple)](https://solana.com)
[![ISO 20022](https://img.shields.io/badge/ISO%2020022-pacs.008%20%7C%20pacs.002%20Acsc-green)](https://www.iso20022.org)
[![FINOS FDC3](https://img.shields.io/badge/FINOS-FDC3%20PR%20%232204-orange)](https://github.com/finos/FDC3/pull/2204)

---

## 1. The Core Thesis

In October 2024, Stripe acquired **Bridge.xyz** for **$1.1 Billion**—the largest acquisition in crypto history—to build stablecoin payment rails. But Stripe deployed it inside their proprietary walled garden: merchants still need traditional business bank accounts, SSNs/EINs, manual KYC approval, and Stripe still charges 1.5% while holding funds for days. Autonomous AI agents cannot legally use it.

**`syn-stripe-bridge` does to Stripe what MinIO did to Amazon S3 and Ollama did to OpenAI:**

Instead of asking millions of Web2 developers and AI agents to throw away their code and learn Web3 wallets, gas limits, and RPCs, **we gave Solana the Stripe SDK**.

One line of configuration in your existing codebase:
```python
import stripe

stripe.api_base = "https://bridge.synapticchain.xyz/v1"
stripe.api_key = "sk_live_synaptic_..."
```

Your application continues executing standard `stripe.PaymentIntent.create()` calls, but under the hood:
* **The 2.9% + 30¢ Interchange Tax is Eliminated:** Fee drops from $3.20 to **$0.0007** (99.98% savings).
* **Payouts are Sub-400ms:** Settles in a single Solana slot instead of 2–3 business days.
* **Chargeback Risk is Zero:** Finalized irreversibly at the consensus layer.
* **Reconciliation is Mathematically Deterministic:** Built on Solana Token-2022 `RequiredMemoTransfers`, burning the SWIFT UETR into the ledger at line rate.
* **Autonomous AI Agents are Supported Day One:** Agents auto-onboard via SynapticChain in 1.4s, obtain soulbound credentials, and transact natively.

---

## 2. Universal Settlement Grammar (The Rosetta Stone)

`syn-stripe-bridge` reveals that **Wall Street institutional standards (FINOS FDC3 PR #2204)**, **Silicon Valley commercial APIs (Stripe PaymentIntents)**, and **Solana Token-2022** describe the exact same five primitives:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│   FINOS FDC3 (PR #2204)       STRIPE REST (PaymentIntent)    SOLANA TOKEN-2022 (BankerX)│
├───────────────────────────────┼──────────────────────────────┼─────────────────────────┤
│ raiseIntent("StartPayment")   │ stripe.PaymentIntent.create()│ ptb_compose             │
│ RFC 4122 SWIFT UETR           │ id: "pi_syn_..." / uetr      │ SPL Memo v2 UETR Binding│
│ Debtor BIC & Account          │ customer / payment_method    │ Payer Pubkey / ATA      │
│ Pre-wire Compliance Screening │ Stripe Radar / Auth          │ ADR-555 Enclave (<8ms)  │
│ ISO 20022 pacs.002 Acsc       │ payment_intent.succeeded     │ 400ms Confirmed Slot Tx │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Quickstart

### Running the Bridge Daemon

```bash
# Clone and enter repo
git clone https://github.com/Synaptics-Lab/syn-stripe-bridge.git
cd syn-stripe-bridge

# Run tests (100% passing in-memory test suite)
npm test

# Start the bridge server on port 8092
npm start
# → http://127.0.0.1:8092
```

### Python SDK Usage (`stripe-python`)

```python
import stripe

stripe.api_base = "http://127.0.0.1:8092/v1"
stripe.api_key = "sk_live_synaptic_..."

intent = stripe.PaymentIntent.create(
    amount=10000,  # $100.00
    currency="usd",
    confirm=True,
    metadata={
        "corridor": "USD-ZMW",
        "debtor_name": "Standard Chartered London",
        "debtor_bic": "SCBLGB2LXXX",
        "creditor_name": "GescoPay Lusaka Desk",
        "creditor_bic": "ZABCZMLUXXX"
    }
)

print(f"Status: {intent.status}")
print(f"SWIFT UETR: {intent.metadata.uetr}")
print(f"Solana Signature: {intent.metadata.solana_signature}")
print(f"ISO 20022 Status: {intent.metadata.iso20022_status}")  # Acsc
```

### Node.js SDK Usage (`stripe-node`)

```javascript
import Stripe from 'stripe';

const stripe = new Stripe('sk_live_synaptic_...', {
    apiVersion: '2024-06-20',
    host: '127.0.0.1',
    port: 8092,
    protocol: 'http'
});

const intent = await stripe.paymentIntents.create({
    amount: 5000,
    currency: 'usd',
    confirm: true
});

console.log('Payment Succeeded:', intent.id, intent.status);
```

### cURL Usage

```bash
curl -X POST http://127.0.0.1:8092/v1/payment_intents \
  -H "Authorization: Bearer sk_live_synaptic_..." \
  -d "amount=10000" \
  -d "currency=usd" \
  -d "confirm=true" \
  -d "metadata[corridor]=USD-ZMW"
```

---

## 4. Architecture Sequence

```mermaid
sequenceDiagram
    autonumber
    actor Merchant as Merchant / AI Agent
    participant Bridge as syn-stripe-bridge (:8092)
    participant ISO as CBPR+ Validator
    participant Solana as Solana Token-2022
    participant Webhook as Merchant Webhook Listener

    Merchant->>Bridge: POST /v1/payment_intents (amount, currency, confirm=true)
    Bridge->>Bridge: Allocate RFC 4122 SWIFT UETR (UUIDv4)
    Bridge->>ISO: Synthesize pacs.008.001.08 XML Wire
    ISO->>Bridge: Validate 14/14 CBPR+ Rules (PASS)
    Bridge->>Solana: Assemble & Sign Wire Tx (SPL Memo + Transfer)
    Solana-->>Bridge: Validated Slot Finality (400ms)
    Bridge-->>Merchant: Return Stripe PaymentIntent (status: "succeeded")
    Bridge->>Webhook: POST Webhook (payment_intent.succeeded + HMAC-SHA256 signature)
```

---

## 5. Deployment with PM2

```bash
chmod +x scripts/deploy_pm2.sh
./scripts/deploy_pm2.sh
```

Nginx configuration snippet for public gateway routing:
```nginx
location /v1/ {
    proxy_pass http://127.0.0.1:8092/v1/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

---

## 6. Author & License

* **Architect:** Abdul Shabazz (`veritasvaultone@gmail.com`)
* **Organization:** Synaptics Lab & FINOS Contributors
* **License:** Apache License 2.0 (see [LICENSE](LICENSE))
