#!/usr/bin/env python3
"""
syn-stripe-bridge v0.2 — official-Stripe-SDK demo (honest, v0.2 flow).

Demonstrates the real drop-in sequence against a running bridge on :8092:
  POST /v1/deposits (evidenced prefund)  ->  POST /v1/payment_intents
  ->  POST /v1/payment_intents/:id/confirm  ->  iso20022.rail_signature + receipt.

Prerequisites:
    pip install stripe requests
    export STRIPE_BRIDGE_API_KEY=sk_bridge_...      # your merchant bearer
    export STRIPE_BRIDGE_DEPOSIT_SIG=<solana sig>   # a real, UNVERIFIED deposit
                                                    # transferChecked into custody
                                                    # with memo X402:<merchant_id>

Usage:
    python demo_python_client.py
"""

import os
import sys

try:
    import requests
    import stripe
except ImportError as e:
    print(f"missing dependency: {e}\npip install stripe requests")
    sys.exit(1)

BASE = os.environ.get("STRIPE_BRIDGE_BASE", "http://127.0.0.1:8092")
API_KEY = os.environ.get("STRIPE_BRIDGE_API_KEY", "")
DEPOSIT_SIG = os.environ.get("STRIPE_BRIDGE_DEPOSIT_SIG", "")
MERCHANT_ID = os.environ.get("STRIPE_BRIDGE_MERCHANT_ID", "pilot")
RECIPIENT = os.environ.get("STRIPE_BRIDGE_RECIPIENT", "")

if not API_KEY:
    print("STRIPE_BRIDGE_API_KEY not set — export your merchant bearer first.")
    sys.exit(1)

# Standard Stripe SDK pointed at the bridge. NOTE: no trailing /v1 — the SDK
# appends /v1 to api_base itself.
stripe.api_base = BASE
stripe.api_key = API_KEY


def run_demo():
    print("=" * 60)
    print(f"syn-stripe-bridge demo — {BASE}")
    print("=" * 60)

    # 0) honest health + custody gate
    health = requests.get(f"{BASE}/health", timeout=10).json()
    print(f"[0] bridge {health['version']} rail={health['rail']['chain']}")
    print(f"    OUSD mint: {health['rail']['ousd_mint']}")

    # 1) prefund: verify a REAL deposit from the chain (single-use, exact-once)
    if DEPOSIT_SIG:
        dep = requests.post(
            f"{BASE}/v1/deposits",
            json={"signature": DEPOSIT_SIG},
            headers={"Authorization": f"Bearer {API_KEY}"},
            timeout=30,
        ).json()
        print(f"[1] deposit: units={dep.get('units')} verified={dep.get('verified_from_chain')}"
              f" balance_raw={ (dep.get('balance') or {}).get('raw') }")
    else:
        print("[1] deposit: STRIPE_BRIDGE_DEPOSIT_SIG not set — skipping (balance must be prefunded).")

    if not RECIPIENT:
        print("[2] STRIPE_BRIDGE_RECIPIENT not set — nothing to settle. Done (honest).")
        return

    # 2) create with the standard SDK (form-encoded dialect — bridge parses it)
    intent = stripe.PaymentIntent.create(
        amount=25000,  # $250.00
        currency="usd",
        metadata={
            "solana_recipient": RECIPIENT,
            "debtor_name": "Demo Merchant Treasury",
            "debtor_bic": "DEMOUS33XXX",
            "creditor_name": "Demo Recipient Desk",
            "creditor_bic": "DEMOUS33YYY",
        },
    )
    print(f"[2] created {intent.id} status={intent.status}")

    # 3) confirm (gated settlement: 402s are honest refusals, never fabrications)
    conf = requests.post(
        f"{BASE}/v1/payment_intents/{intent.id}/confirm",
        headers={"Authorization": f"Bearer {API_KEY}"},
        timeout=60,
    )
    body = conf.json()
    print(f"[3] confirm → HTTP {conf.status_code} status={body.get('status')}")
    if body.get("status") == "succeeded":
        iso = body["iso20022"]
        print(f"    rail signature: {iso['rail_signature']}")
        print(f"    pacs.002:       {iso['pacs002_report']['transaction_information_and_status'][0]['transaction_status']}")
        print(f"    receipt:        {body['receipt_url']}")
        print(f"    gate:           {body.get('last_verification')}")
    else:
        # settlement_broken / processing / 402 — printed AS the honest outcome
        print(f"    honest outcome: {body}")


if __name__ == "__main__":
    run_demo()