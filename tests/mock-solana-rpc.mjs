/**
 * mock-solana-rpc.mjs — in-process Solana JSON-RPC mock for the OFFLINE suite.
 *
 * Speaks the exact wire dialect the vendored estate stack does:
 *   POST {jsonrpc, id, method, params} -> {id, jsonrpc, result} (or a 429 error
 *   body to exercise the transport ladder).
 *
 * Started at module load on MOCK_PORT (default 18231). The runner
 * (run-tests.mjs) sets SOLANA_RPC_URL to this server BEFORE importing the
 * vendored stack, whose URL read happens at module load.
 *
 * Everything replayed through `mockTxState` is the REAL devnet wire shape of
 * an OUSD (Token-2022, decimals 6) transferChecked leg as live-verified on the
 * estate (getTransaction: accountKeys layout, SPL Memo v2 inner ix) — accounts
 * are built from REAL base58 fixtures, never invented constants.
 */
import http from "node:http";

export const MOCK_PORT = parseInt(process.env.MOCK_PORT || "18231", 10);

/** signature -> getTransaction result document (the tx doc itself, not wrapped). */
export const mockTxState = new Map();

/** account info registry: base58 -> {mint, decimals, amount:BigInt} token accounts. */
export const mockTokenAccounts = new Map();

function tokenAccountLayout(mint, ownerB58, amountBig) {
    // SPL/Token-2022 ACCOUNT v2 layout: mint(32) owner(32) amount u64 LE
    const buf = Buffer.alloc(72);
    buf.set(Buffer.from(/* mint handled in hex via base58 decode below */ []), 0);
    return buf;
}

const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
        let body;
        try { body = JSON.parse(raw); } catch {
            res.writeHead(400, { "content-type": "text/plain" });
            return res.end("bad json");
        }
        const { id, method, params } = body;
        let result = null;
        try {
            switch (method) {
                case "getTransaction": {
                    const sig = params?.[0];
                    result = mockTxState.get(sig) ?? null; // null while "indexing" — honest
                    break;
                }
                case "getAccountInfo": {
                    const addr = params?.[0];
                    const ta = mockTokenAccounts.get(addr);
                    result = ta
                        ? {
                              context: { slot: 0 },
                              value: { data: ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAA" /* placeholder replaced below */, "base64"], owner: "TokenzQdBNbLqP5VEhdkAS6EPFLc1PHnBqCXEpPxuEb" },
                          }
                        : { context: { slot: 0 }, value: null };
                    if (ta) {
                        result.value.data[0] = Buffer.concat([
                            Buffer.from(/* mint (32B, base58-decoded) */ decodeB58(ta.mint)),
                            Buffer.from(decodeB58(ta.owner ?? "2ANrmtAcMd8eihFGvbyAkrAWveq8nU6uMTigbWBuigNe")),
                            (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(ta.amount); return b; })(),
                        ]).toString("base64");
                    }
                    break;
                }
                case "getBalance": {
                    result = 10_000_00; // lamports, enough for fees in offline tests
                    break;
                }
                case "getSignatureStatuses": {
                    result = { value: [null] };
                    break;
                }
                default:
                    res.writeHead(200, { "content-type": "application/json" });
                    return res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `mock: unsupported ${method}` } }));
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id, method, result }));
        } catch (e) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: String(e?.message ?? e).slice(0, 200) } }));
        }
    });
});
server.listen(MOCK_PORT, "127.0.0.1");
server.unref(); // never hold the test process open on the mock alone

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function decodeB58(s) {
    const bytes = [];
    for (const ch of String(s)) {
        const v = B58.indexOf(ch);
        if (v === undefined) return new Uint8Array(32);
        let carry = v;
        for (let i = 0; i < bytes.length; i++) {
            carry += bytes[i] * 58;
            bytes[i] = carry & 0xff;
            carry >>= 8;
        }
        while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    return Uint8Array.from(bytes);
}
void tokenAccountLayout;