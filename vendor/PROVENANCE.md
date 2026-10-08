# Vendor provenance

Every file in `vendor/` is copied **from the SynapticChain estate monorepo**
(`/opt/synapticchain`, mirrored as `Synaptic-Source`) — never written backward,
never hand-rolled here. The bridge's no-npm-install story depends on vendored
code, and the estate's law is that wire codecs are never reinvented downstream.

| Vendored file | Source (estate path) | Notes |
|---|---|---|
| `vendor/discriminators.mjs` | `Synaptic-Source/apps/x402-tswp/src/discriminators.mjs` | X402-TSWP typed SSOT, md5 `31c8105e8f3b00c677434e9fa55b4aa9`. Copy-identical; verify with `md5sum` before/after every sync. |
| `vendor/solana-tx.mjs` | `synaptic-fx-terminal/lib/solana/handrolled-solana.mjs` | The live-proven dependency-free Solana wire stack (R13.1–R13.3 + Task-8.5 transport classification + Token-2022 extension + Helius devnet fallback). Superset of `mcp/escrow-server/solana-tx.mjs`. |
| `vendor/ata.mjs` | `mcp/ptb-controller/ata.mjs` | PDA/ATA derivation + ComputeBudget + ATokenGP CreateIdempotent. **One patched line:** the two estate-relative imports now point to `./solana-tx.mjs` and `./vendor-noble/node_modules/@noble/curves/ed25519.js`; every other byte is unchanged. |
| `vendor/vendor-noble/node_modules/@noble/{curves,hashes}` | `mcp/escrow-server/node_modules/@noble/{curves,hashes}` | Static import closure of `curves/ed25519.js` (24 files, v2.4.0, MIT). Only `Point.fromBytes` (the PDA on-curve check) is used. Package JSONs copied so bare-specifier imports inside the tree resolve. |

## Sync law (operator directive)

Vendored copies sync **FROM the estate monorepo only** — never patch vendor
files to "fix" bridge behavior; patch the estate source first, then re-copy.
Exception: `vendor/ata.mjs` import-path patch above, which exists only because
the estate file reaches outside its own tree (`../escrow-server/…`).

## Differential proof

VendoredATA derivation is proven byte-exact against the estate implementation
(estate `ata.mjs` vs vendored `ata.mjs`, same owner/mint → identical ATA),
and `discriminators.mjs` is proven md5-identical to the SSOT. Tests in
`tests/` re-run both checks offline.