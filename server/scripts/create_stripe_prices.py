#!/usr/bin/env python3
"""Create one Stripe Product + one-time Price per credit package, then print the
ready-to-paste CREDIT_PACKAGES line (with the real price IDs).

The key is read from the STRIPE_SECRET_KEY env var and never printed. Run it with
your key inline so the key stays on your machine:

    STRIPE_SECRET_KEY=sk_live_xxx python3 server/scripts/create_stripe_prices.py

Use the SAME mode (test vs live) as the key you run the server with — Stripe
prices are not shared between test and live. Re-running creates duplicate
products, so run it once and paste the printed line into Railway's CREDIT_PACKAGES
(or server/.env), keeping the single quotes.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

# id, name, price the customer pays (USD), credits granted (USD).
PACKAGES = [
    {"id": "starter", "name": "Starter", "price_usd": 5.00, "credits_usd": 5.00},
    {"id": "plus", "name": "Plus", "price_usd": 15.00, "credits_usd": 17.00},
    {"id": "pro", "name": "Pro", "price_usd": 30.00, "credits_usd": 36.00},
    {"id": "business", "name": "Business", "price_usd": 60.00, "credits_usd": 80.00},
]

sk = os.environ.get("STRIPE_SECRET_KEY", "")
if not sk.startswith("sk_"):
    sys.exit("Set STRIPE_SECRET_KEY to a secret key (sk_test_… or sk_live_…).")
mode = "LIVE" if sk.startswith("sk_live_") else "TEST"
print(f"# Creating products in Stripe {mode} mode\n", file=sys.stderr)


def stripe_post(path, data):
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(
        "https://api.stripe.com/v1/" + path, data=body,
        headers={"Authorization": "Bearer " + sk},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        sys.exit(f"Stripe error on {path}: {e.code} {e.read().decode()[:300]}")


for p in PACKAGES:
    product = stripe_post("products", {"name": f"VoxTranslate {p['name']} credits"})
    cents = int(round(float(p["price_usd"]) * 100))
    price = stripe_post(
        "prices", {"product": product["id"], "unit_amount": cents, "currency": "usd"}
    )
    p["stripe_price_id"] = price["id"]
    print(f"  {p['id']:9} ${p['price_usd']:<6} -> {price['id']}", file=sys.stderr)

line = "CREDIT_PACKAGES='" + json.dumps(PACKAGES, separators=(",", ":")) + "'"
print("\n# Paste this into Railway's CREDIT_PACKAGES (value only, without the\n"
      "# CREDIT_PACKAGES= prefix) — or into server/.env as-is:\n", file=sys.stderr)
print(line)
