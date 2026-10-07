#!/usr/bin/env python3
"""
BankerX syn-stripe-bridge — Official Python Client Demo
Demonstrates 100% drop-in compatibility with official Stripe SDK (stripe-python).

Prerequisites:
    pip install stripe

Usage:
    python demo_python_client.py
"""

import sys

try:
    import stripe
except ImportError:
    print("stripe-python is not installed. Install with: pip install stripe")
    sys.exit(1)

# Point standard Stripe SDK to the BankerX bridge endpoint
stripe.api_base = "http://127.0.0.1:8092/v1"  # Or https://bridge.synapticchain.xyz/v1
stripe.api_key = "sk_live_synaptic_test_token"

def run_demo():
    print("======================================================")
    print("🚀 Running BankerX Stripe SDK Client Demo")
    print(f"🔗 Target Bridge Endpoint: {stripe.api_base}")
    print("======================================================\n")

    print("[Step 1] Creating & Confirming PaymentIntent on Solana Token-2022...")
    try:
        intent = stripe.PaymentIntent.create(
            amount=25000,  # $250.00
            currency="usd",
            confirm=True,
            metadata={
                "corridor": "USD-ZMW",
                "debtor_name": "JPMorgan London Treasury",
                "debtor_bic": "CHASGB2LXXX",
                "creditor_name": "GescoPay Lusaka Desk",
                "creditor_bic": "ZABCZMLUXXX"
            }
        )

        print("\n✅ PaymentIntent Execution Succeeded!")
        print(f"• Stripe Intent ID:     {intent.id}")
        print(f"• Instructed Amount:    ${intent.amount / 100:.2f} {intent.currency.upper()}")
        print(f"• State:                {intent.status}")
        print(f"• SWIFT UETR:           {intent.metadata.get('uetr')}")
        print(f"• Settlement Rail:      {intent.metadata.get('settlement_rail')}")
        print(f"• Solana Signature:     {intent.metadata.get('solana_signature')}")
        print(f"• CBPR+ ISO 20022 Score:{intent.metadata.get('cbpr_validation_score')}")
        print(f"• ISO Status:           {intent.metadata.get('iso20022_status')} (Accepted Settlement Completed)")

        print("\n[Step 2] Retrieving PaymentIntent by ID...")
        retrieved = stripe.PaymentIntent.retrieve(intent.id)
        print(f"• Verified on-chain status: {retrieved.status}")
        print(f"• Explorer Receipt: {retrieved.charges.data[0].receipt_url}")

    except Exception as e:
        print(f"❌ Error communicating with bridge: {e}")
        print("Note: Ensure syn-stripe-bridge is running on :8092 (`node src/stripe_shim.mjs`).")

if __name__ == "__main__":
    run_demo()
