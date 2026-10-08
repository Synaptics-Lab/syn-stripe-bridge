// X402-TSWP — Typed Source of Truth (SSOT) for the operational discriminator
// registry. Spec: draft-shabazz-http-x402-tswp-01 (§3 wire grammar, §4
// discriminator registry); estate matrix: docs/X402_TSWP_DISCRIMINATOR_INTEGRATION_MAP.md.
//
// Zero-dependency ESM. Byte-exact everywhere: memo payloads are verified by
// exact segment comparison, never regex or prefix/prefix-match heuristics
// (draft §8.3). Unknown or malformed payloads fail CLOSED at the first
// constraint that breaks — including leading-zero decimal fields, non-ASCII
// octets, whitespace, and oversized segments (draft §3).
//
// Canonical author attribution: Abdul Shabazz <veritasvaultone@gmail.com>.

// ---------------------------------------------------------------------------
// Grammar constants (draft §3 ABNF — ASCII only, VCHAR, no whitespace)
// ---------------------------------------------------------------------------
const PREFIX = 'X402';
const MAX_SEGMENT = 128; // payload = 1*128 VCHAR per segment
const MAX_TOTAL = 255;   // multi-field variants (X402W:window:participant) get headroom

// Bech32m character class for `syn1…` addresses (lowercase; excludes 1, b, i, o).
const SYN_ADDR_RE = /^syn1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/;
// RFC 4122 UUIDv4, lowercase hyphenated, byte-exact (draft §4: X402G, X402E).
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// SHA3-256 canonical manifest / state roots used by X402Z — 64-hex lowercase.
const HEX64_RE = /^[0-9a-f]{64}$/;
// Decimal fields: no leading zeros (draft §5.1 amount rule, applied to all
// numeric fields). "0" itself is valid.
const DECIMAL_RE = /^[0-9]+$/;
// ADR-555 attestation-root slice as the desk embeds it on-chain (lead-16 hex)
// or the full root when the emitter commits all 64 bytes.
const ATS_ROOT_RE = /^[0-9a-f]{16}([0-9a-f]{48})?$/;

function isDecimalField(s) {
  return DECIMAL_RE.test(s) && (s === '0' || s[0] !== '0');
}

function isVCharSegment(s) {
  // 1*128 VCHAR — printable ASCII 0x21–0x7E, no whitespace, no non-ASCII octets.
  if (s.length < 1 || s.length > MAX_SEGMENT) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
}

function isCorridor(s) {
  // Corridor ids: lowercase tokens with hyphens (USD-TZS, xrp-to-ckes, cTZS).
  if (!isVCharSegment(s)) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const ok =
      (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9') || c === '-' || c === '_' || c === '.';
    if (!ok) return false;
  }
  return s.length >= 2;
}

function isSession(s) {
  // Session tokens: alphanumeric with hyphens/underscores (bond-fcf217a2-…-n, 12, sess-8891).
  if (!isVCharSegment(s)) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const ok =
      (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9') || c === '-' || c === '_';
    if (!ok) return false;
  }
  return s.length >= 1;
}

function isReason(s) {
  // Failure reasons: UPPER_SNAKE-style tokens for the honest-rejection proof (SYN-TD-001).
  if (!isVCharSegment(s)) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const ok =
      (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '-';
    if (!ok) return false;
  }
  return s.length >= 3;
}

function isLane(s) {
  return isDecimalField(s) && Number(s) >= 0 && Number(s) <= 255;
}

// pacs.008 MsgId: ≤35 chars, alphanumeric tokens with punctuation that survives
// the VCHAR rule (ISO 20022 message identifiers never carry '%', ':', space).
function isMsgId(s) {
  if (!isVCharSegment(s) || s.length > 35) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const ok =
      (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9') || c === '-' || c === '_' || c === '.';
    if (!ok) return false;
  }
  return s.length >= 1;
}

// Treasury/agent-service levy in basis points — 0..10000 (100% is the ceiling).
function isTsaBps(s) {
  return isDecimalField(s) && Number(s) <= 10000;
}

function isProofToken(s) {
  // ZK proof handles (SYN-TD-008/012): lowercase alphanumeric with hyphens.
  if (!isVCharSegment(s)) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-';
    if (!ok) return false;
  }
  return s.length >= 8;
}

// Asset-binding tags (X402A) name the instrument a settlement moves. Asset
// symbols: uppercase alnum 2–16, letter-led (OUSD, cTZS, SOL).
const ASSET_RE = /^[A-Z][A-Z0-9]{1,15}$/;

// Base58 (Bitcoin alphabet) decode — zero-dependency, mirrors the composition
// authority's `assertBase58Key` semantics: exactly 32 bytes when decoded, so a
// mint identifier is a real Solana pubkey (base58 length alone is not enough;
// all-'1s' decodes to leading zeros and is refused the same way).
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58Decode32(s) {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return null;
  let bytes = [0];
  for (let i = 0; i < s.length; i++) {
    const val = B58_ALPHABET.indexOf(s[i]);
    if (val < 0) return null;
    for (let j = bytes.length - 1; j >= 0; j--) {
      const t = bytes[j] * 58 + val;
      bytes[j] = t & 0xff;
      const carry = t >> 8;
      if (!j && carry) bytes.unshift(carry);
    }
  }
  let z = 0;
  while (z < s.length && s[z] === '1') z++;
  if (z) bytes = new Array(z).concat(bytes);
  if (bytes.length !== 32) return null;
  return bytes;
}

function isMint(s) {
  return b58Decode32(s) !== null;
}

// Per-tag segment validators. Field order is normative from draft §4 + the
// estate matrix. Segments arrive split on ':' — the caller strips framing.
// X402W/X402N field 1 is decimal: window epoch (legacy) or numeric session id
// (R16 clearinghouse cycle) — every live id is numeric.
const TAG_VALIDATORS = {
  '':  (seg) => {
        // Desk attestation tail (F-19 SSOT convergence): `X402:<corridor>:<uetr>:ATS:<root>`
        // — the synaptic-fx-terminal XRPL settler frame. ADDITIVE ONLY: the legacy
        // 1–2-segment forms below are byte-for-byte unchanged.
        if (seg.length === 4 && seg[2] === 'ATS')
          return isCorridor(seg[0]) && UUID_V4_RE.test(seg[1]) && ATS_ROOT_RE.test(seg[3]);
        return seg.length >= 1 && seg.length <= 2
              && isCorridor(seg[0])
              && (seg.length === 1 || UUID_V4_RE.test(seg[1]));
      },
  'G': (seg) => seg.length === 1 && UUID_V4_RE.test(seg[0]),
  'L': (seg) => seg.length === 3 && isLane(seg[0]) && isDecimalField(seg[1]) && isDecimalField(seg[2]),
  'M': (seg) => seg.length === 2 && isCorridor(seg[0]) && SYN_ADDR_RE.test(seg[1]),
  'MR': (seg) => seg.length === 2 && isCorridor(seg[0]) && SYN_ADDR_RE.test(seg[1]),
  'N': (seg) => seg.length === 2 && isDecimalField(seg[1]),
  'E': (seg) => seg.length === 2 && isCorridor(seg[0]) && UUID_V4_RE.test(seg[1]),
  'B': (seg) => seg.length === 2 && isSession(seg[0]) && SYN_ADDR_RE.test(seg[1]),
  // ADV-F-19 closure: X402BN carries an OPTIONAL terminal UETR segment. The
  // 2-segment form (legacy LIVE_ONCHAIN memos) stays byte-for-byte valid;
  // the 3-segment form witnesses the CAN netting leg's UETR in the wire
  // bytes themselves (covenant: memo ⊇ UETR holds for the estate's canonical
  // CAN v2 sweep legs, not just corridor legs). UETR is strict UUIDv4.
  'BN': (seg) =>
    (seg.length === 2 && isSession(seg[0]) && SYN_ADDR_RE.test(seg[1])) ||
    (seg.length === 3 && isSession(seg[0]) && SYN_ADDR_RE.test(seg[1]) && UUID_V4_RE.test(seg[2])),
  'BR': (seg) => seg.length === 2 && isSession(seg[0]) && SYN_ADDR_RE.test(seg[1]),
  'Z': (seg) => seg.length === 2 && HEX64_RE.test(seg[0]) && isProofToken(seg[1]),
  'R': (seg) => seg.length === 2 && isSession(seg[0]) && isReason(seg[1]),
  // P (F-19 SSOT convergence): desk pacs.008 settlement carrier — the desk's
  // on-chain frame is BUILT via the controlled constructor and validated here;
  // amount is the canonical MINOR-unit integer actually transferred and the
  // levy is in basis points (never a UI string like "0.50%").
  'P':  (seg) => seg.length >= 4 && seg.length <= 5
        && UUID_V4_RE.test(seg[0]) && isMsgId(seg[1]) && isDecimalField(seg[2])
        && isTsaBps(seg[3])
        && (seg.length === 4 || ATS_ROOT_RE.test(seg[4])),
  // A (SEP-0001 asset binding, x402-tswp repo): binds the settlement asset
  // symbol to its on-chain token mint identifier + wire decimals — the memo
  // witnesses WHICH instrument moved, issuer-agnostic by construction
  // (inaugural registration: OUSD / Open Standard, mainnet Token-2022 mint
  // ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB, decimals 6, RPC-verified
  // 2026-10-07). Mint must decode to exactly 32 bytes (assertBase58Key
  // parity); decimals are the u8 wire decimals transfer_checked enforces.
  'A': (seg) => seg.length === 3 && ASSET_RE.test(seg[0]) && isMint(seg[1])
        && isDecimalField(seg[2]) && Number(seg[2]) <= 255,
};

// W: decimal window-or-session (no leading zeros, R16 numeric session ids fit) + syn address.
TAG_VALIDATORS['W'] = (seg) => seg.length === 2 && isDecimalField(seg[0]) && SYN_ADDR_RE.test(seg[1]);

// ---------------------------------------------------------------------------
// Registry: the 12 canonical discriminators (integration-map §2) + the legacy
// bare `X402:<corridor>[:<uetr>[:ATS:<root>]]` carrier still LIVE_GATEWAY in the
// estate, + the desk pacs.008 carrier (X402P) admitted by the F-19 SSOT
// convergence (UTA-2026-10-03-001). Statuses are the canonical estate statuses
// from the integration map.
// ---------------------------------------------------------------------------
const DISCRIMINATOR_REGISTRY = {
  '': {
    syntax: 'X402:<corridor>[:<uetr>]', tag: '', status: 'LIVE_GATEWAY',
    service: 'gateway.mjs / the relayer',
    rails: ['xrpl-altnet'],
    description: 'legacy corridor settlement payment carrier (pre-tag registry form)',
  },
  'G': {
    syntax: 'X402G:<challenge>', tag: 'G', status: 'LIVE_ONCHAIN',
    service: 'mcp-402-gateway (:8402) / nodes-api',
    rails: ['xrpl-altnet', 'solana-devnet'],
    description: 'gateway paywall — single-use UUIDv4 challenge funding metered MCP tool access',
  },
  'L': {
    syntax: 'X402L:<lane>:<window>:<nonce>', tag: 'L', status: 'STANDARDS_TRACK',
    service: 'IETF draft-shabazz-http-x402-tswp-01 / Solana SIMD-0671',
    rails: ['solana-devnet', 'synaptic-l1'],
    description: 'parametric 256-lane watermark nonce routing (ADR-062)',
  },
  'W': {
    syntax: 'X402W:<window>:<participant_syn>', tag: 'W', status: 'LIVE_ONCHAIN',
    service: 'mcp-402-gateway-escrow (:8405) / clearinghouse.mjs',
    rails: ['xrpl-altnet', 'solana-devnet'],
    description: 'net settlement wire — window + participant address on BOTH rails',
  },
  'M': {
    syntax: 'X402M:<corridor>:<maker_syn>', tag: 'M', status: 'LIVE_ONCHAIN',
    service: 'mcp-402-gateway / gateway.mjs',
    rails: ['xrpl-altnet'],
    description: 'maker margin escrow linkage (carried on the EscrowCreate TRANSACTION memo)',
  },
  'MR': {
    syntax: 'X402MR:<corridor>:<maker_syn>', tag: 'MR', status: 'LIVE_GATEWAY',
    service: 'mcp-402-gateway / escrow-server',
    rails: ['xrpl-altnet'],
    description: 'margin return payment to the maker after netting completes',
  },
  'E': {
    syntax: 'X402E:<corridor>:<uetr>', tag: 'E', status: 'LIVE_ONCHAIN',
    service: 'mcp-402-gateway-escrow (:8405)',
    rails: ['xrpl-altnet'],
    description: 'ISO 20022 cross-border linkage — escrow release bound to a SWIFT gpi UETR',
  },
  'B': {
    syntax: 'X402B:<session>:<consumer>', tag: 'B', status: 'LIVE_ONCHAIN',
    service: 'escrow-server/index.mjs (:8405)',
    rails: ['xrpl-altnet'],
    description: 'bond escrow create — session linkage for inference bonds',
  },
  'BN': {
    syntax: 'X402BN:<session>:<consumer>[:<uetr>]', tag: 'BN', status: 'LIVE_ONCHAIN',
    service: 'escrow-server/index.mjs (:8405)',
    rails: ['xrpl-altnet', 'solana-devnet'],
    description: 'netted bond fee settlement — ONE net fee per session on the consumer rail; CAN v2 sweep legs append the leg UETR as the optional terminal segment (UTA-2026-10-03-001 ADV-F-19 closure)',
  },
  'BR': {
    syntax: 'X402BR:<session>:<consumer>', tag: 'BR', status: 'LIVE_ONCHAIN',
    service: 'escrow-server/index.mjs (:8405)',
    rails: ['xrpl-altnet'],
    description: 'bond release — full collateral return to the consumer',
  },
  'N': {
    syntax: 'X402N:<session>:<net>', tag: 'N', status: 'LIVE_ONCHAIN',
    service: 'clearinghouse.mjs (:8405)',
    rails: ['xrpl-altnet', 'solana-devnet'],
    description: 'consensus net readback — the CHAIN’s net amount, verbatim',
  },
  'Z': {
    syntax: 'X402Z:<root>:<proof>', tag: 'Z', status: 'STANDARDS_TRACK',
    service: 'CERN Zenodo SYN-TD-008 / SYN-TD-012',
    rails: ['synaptic-l1', 'xrpl-altnet'],
    description: 'zero-knowledge ISO 20022 confidential clearing attestation',
  },
  'R': {
    syntax: 'X402R:<session>:<reason>', tag: 'R', status: 'STANDARDS_TRACK',
    service: 'CERN Zenodo SYN-TD-001 / mcp-402-gateway',
    rails: ['xrpl-altnet', 'synaptic-l1'],
    description: 'honest-rejection cryptographic dispute proof — fail-closed evidence',
  },
  'P': {
    syntax: 'X402P:<uetr>:<msg_id>:<minor_amount>:<tsa_bps>[:<ats_root>]', tag: 'P', status: 'LIVE_GATEWAY',
    service: 'synaptic-fx-terminal desk settler (UTA-2026-10-03-001-F-19 SSOT convergence)',
    rails: ['solana-devnet'],
    description: 'desk pacs.008 settlement — FI-to-FI Token-2022 transfer bound to its SWIFT gpi UETR, message id, transferred minor units, TSA levy (bps), optional ADR-555 attestation-root lead-16',
  },
  'A': {
    syntax: 'X402A:<asset>:<mint>:<decimals>', tag: 'A', status: 'STANDARDS_TRACK',
    service: 'x402-tswp asset registry (SEP-0001) / ptb-controller (:8416) / synaptic-fx-terminal',
    rails: ['solana-devnet', 'synaptic-l1'],
    description: 'issuer-agnostic asset binding — binds the settlement asset symbol to its on-chain token mint identifier + wire decimals so the memo witnesses WHICH instrument moved; inaugural registration: OUSD (Open Standard, mainnet Token-2022 mint ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB, decimals 6, RPC-verified 2026-10-07). External issuance on mainnet — devnet executors honestly refuse OUSD-class legs rather than fake a settlement',
  },
};

// ---------------------------------------------------------------------------
// Validation — fail closed on the first violated constraint.
// validateTswpMemo(memo) -> { valid, tag, subtype, segments, error }
//   valid:  boolean
//   tag:    registry key ('' | 'G' | … ) when the frame parses structurally
//   subtype: second qualifier letter for compound tags ('MR' -> 'R'), else ''
//   segments: split payload fields (no ':' framing)
//   error:  null, or a fail-closed reason string
// ---------------------------------------------------------------------------

// Registry keys sorted longest-first so compound tags (BR/BN/MR) match before
// their single-letter prefixes.
const TAG_KEYS = Object.keys(DISCRIMINATOR_REGISTRY).filter(Boolean)
  .sort((a, b) => b.length - a.length);

export function validateTswpMemo(memo) {
  const fail = (error, tag = null, segments = []) => ({ valid: false, tag, subtype: '', segments, error });

  if (typeof memo !== 'string' || memo.length === 0) return fail('empty_or_not_a_string');
  if (memo.length < 4) return fail('shorter_than_prefix');
  if (!memo.startsWith(PREFIX)) return fail('bad_prefix_at_byte_0');

  const rest = memo.slice(4);

  // Tag extraction: greedy uppercase run of ≤2 chars directly after the prefix.
  // Tagless estate form: "X402:" with the run empty → registry key ''.
  let tag = '';
  let i = 0;
  while (i < rest.length - 1 && i < 2 && rest[i] >= 'A' && rest[i] <= 'Z') i++;
  tag = rest.slice(0, i);
  if (i === rest.length - 1 || rest[i] !== ':') return fail('missing_payload_separator', tag || null);
  const payload = rest.slice(i + 1);
  const sub = tag.length === 2 ? tag[1] : '';

  if (!Object.prototype.hasOwnProperty.call(DISCRIMINATOR_REGISTRY, tag)) {
    return fail('unknown_discriminator', tag || null);
  }

  // Whole-frame byte rules (draft §3): ASCII only, no whitespace, bounded size.
  for (let j = 0; j < memo.length; j++) {
    const c = memo.charCodeAt(j);
    if (c < 0x21 || c > 0x7e) return fail('non_vchar_octet', tag);
  }
  if (memo.length > MAX_TOTAL + 5) return fail('frame_too_long', tag);

  const segments = payload.split(':');
  for (const seg of segments) {
    if (seg.length > MAX_SEGMENT) return fail('segment_too_long', tag);
    if (seg.length === 0) return fail('empty_segment', tag);
  }

  const check = TAG_VALIDATORS[tag];
  if (!check || !check(segments)) {
    return { valid: false, tag, subtype: sub, segments, error: 'segment_validation_failed' };
  }
  return { valid: true, tag, subtype: sub, segments, error: null };
}

/** Alias — some call sites read better as "parse". Same fail-closed contract. */
export function parseTswpMemo(memo) {
  return validateTswpMemo(memo);
}

/**
 * Byte-exact comparison for on-chain-facing checks (draft §8.3/§8.4).
 * XOR-accumulate over the shorter length with a length delta folded in,
 * so equal-length payloads with any differing byte yield non-zero.
 */
export function tswpEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const n = Math.min(a.length, b.length);
  let acc = a.length ^ b.length;
  for (let i = 0; i < n; i++) acc |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return acc === 0;
}

// ---------------------------------------------------------------------------
// Controlled constructors — the ONLY sanctioned way to emit a discriminator.
// Every builder validates its inputs and returns `X402<variant>:<payload…>`,
// so construction and verification share one grammar. Throws fail-loud on
// bad input (callers decide how to surface refusals).
// ---------------------------------------------------------------------------
function build(tag, segments) {
  const entry = DISCRIMINATOR_REGISTRY[tag];
  if (!entry) throw new Error(`tswp_build_failed_unknown_tag:${tag}`);
  const memo = tag === '' ? `${PREFIX}:${segments.join(':')}` : `${PREFIX}${tag}:${segments.join(':')}`;
  const check = validateTswpMemo(memo);
  if (!check.valid) throw new Error(`tswp_build_failed:${check.error}:tag=${tag || 'bare'}`);
  return memo;
}

const uuidOr = (v, field) => {
  const s = String(v).toLowerCase();
  if (!UUID_V4_RE.test(s)) throw new Error(`tswp_build_failed_not_uuid4:${field}`);
  return s;
};

export const buildGatewayMemo = (challenge) => build('G', [uuidOr(challenge, 'challenge')]);
export const buildCorridorMemo = (corridor, uetr) =>
  build('', uetr ? [corridor, uuidOr(uetr, 'uetr')] : [corridor]);
export const buildLaneMemo = (lane, window, nonce) =>
  build('L', [String(lane), String(window), String(nonce)]);
export const buildWindowMemo = (window, participant) => build('W', [String(window), participant]);
export const buildMarginMemo = (corridor, maker) => build('M', [corridor, maker]);
export const buildMarginReturnMemo = (corridor, maker) => build('MR', [corridor, maker]);
export const buildEscrowMemo = (corridor, uetr) => build('E', [corridor, uuidOr(uetr, 'uetr')]);
export const buildBondMemo = (session, consumer) => build('B', [session, consumer]);
export const buildNetBondMemo = (session, consumer, uetr) =>
  uetr == null ? build('BN', [session, consumer]) : build('BN', [session, consumer, uuidOr(uetr, 'uetr')]);
export const buildBondReleaseMemo = (session, consumer) => build('BR', [session, consumer]);
export const buildNetReadbackMemo = (session, net) =>
  build('N', [String(session), (() => { const n = String(net); if (!DECIMAL_RE.test(n) || n === '' ) throw new Error('tswp_build_failed_not_decimal:net'); return n; })()]);
export const buildAttestationMemo = (root, proof) => {
  const r = String(root).toLowerCase();
  if (!HEX64_RE.test(r)) throw new Error('tswp_build_failed_not_hex64:root');
  return build('Z', [r, proof]);
};
export const buildRejectionMemo = (session, reason) => build('R', [session, reason]);

// Desk pacs.008 settlement (X402P, F-19 convergence): the desk's ONLY sanctioned
// way to emit its settlement frame. uetr = SWIFT gpi UUIDv4; msgId = pacs.008
// message id; minorAmount = canonical minor-unit integer actually transferred
// (same integer as the transferChecked amount); tsaBps = levy in basis points;
// atsRoot = optional ADR-555 attestation root (lead-16 or full 64-hex, lowercase).
export const buildDeskSettlementMemo = (uetr, msgId, minorAmount, tsaBps, atsRoot) =>
  build('P', [
    uuidOr(uetr, 'uetr'),
    (() => { const s = String(msgId); if (!isMsgId(s)) throw new Error('tswp_build_failed_not_msg_id:msgId'); return s; })(),
    (() => { const s = String(minorAmount); if (!isDecimalField(s) || s === '0') throw new Error('tswp_build_failed_not_decimal:minorAmount'); return s; })(),
    (() => { const s = String(tsaBps); if (!isTsaBps(s)) throw new Error('tswp_build_failed_not_bps:tsaBps'); return s; })(),
    ...(atsRoot != null
      ? [(() => { const s = String(atsRoot).toLowerCase(); if (!ATS_ROOT_RE.test(s)) throw new Error('tswp_build_failed_not_attestation_root:atsRoot'); return s; })()]
      : []),
  ]);

// Desk XRPL corridor frame carrying the attestation tail — the '' carrier plus
// the registered `ATS:<root>` segments (legacy form still accepted byte-for-byte).
export const buildCorridorAttestationMemo = (corridor, uetr, atsRoot) =>
  build('', [corridor, uuidOr(uetr, 'uetr'), 'ATS',
    (() => { const s = String(atsRoot).toLowerCase(); if (!ATS_ROOT_RE.test(s)) throw new Error('tswp_build_failed_not_attestation_root:atsRoot'); return s; })()]);

// Asset binding (SEP-0001): the ONLY sanctioned way to emit the issuer-agnostic
// instrument binding. asset = uppercase alnum 2–16 letter-led; mint = Solana
// pubkey (base58, exactly 32 bytes); decimals = u8 wire decimals (0..255,
// transfer_checked-enforced). Inaugural registration, OUSD (Open Standard):
//   X402A:OUSD:ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB:6
export const buildAssetBindingMemo = (asset, mint, decimals) =>
  build('A', [
    (() => { const s = String(asset); if (!ASSET_RE.test(s)) throw new Error('tswp_build_failed_not_asset_symbol:asset'); return s; })(),
    (() => { const m = String(mint); if (b58Decode32(m) === null) throw new Error('tswp_build_failed_not_base58_pubkey:mint'); return m; })(),
    (() => { const s = String(decimals); if (!isDecimalField(s) || Number(s) > 255) throw new Error('tswp_build_failed_not_wire_decimals:decimals'); return s; })(),
  ]);

export { DISCRIMINATOR_REGISTRY };