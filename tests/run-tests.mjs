/**
 * Test runner: the vendored estate stack reads SOLANA_RPC_URL once at module
 * load, so this bootstrap sets the env BEFORE any static import chain runs,
 * then imports the real suite (whose mock server answers that URL).
 */
process.env.SOLANA_RPC_URL = `http://127.0.0.1:${process.env.MOCK_PORT || "18231"}`;
await import("./mock-solana-rpc.mjs");
await import("./test_stripe_shim.mjs");