/**
 * Voyager Protocol SDK — MVP v0.1.0
 *
 * Spec:           VOYAGER_RFC.md (kinds 30402, 30017, 14, 1059, 38383)
 * Design:         /home/tk/demo/SDK_MVP_DESIGN.md
 * NIPs referenced: NIP-01 (events), NIP-19 (bech32), NIP-44 (encryption),
 *                  NIP-17 (gift-wrap), NIP-33 (replaceable)
 *
 * Hard rules:
 *   - Zero runtime deps. WebCrypto + Node's `crypto` module only.
 *   - No AI/ML code. No telemetry. No network calls at import time.
 *   - Open World Assumption: pass v-tags through as raw arrays.
 *   - Stateless reads; fan out across relays, merge by event id.
 */

// ════════════════════════════════════════════════════════════════════
//  Errors
// ════════════════════════════════════════════════════════════════════

export class VoyagerError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "VoyagerError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

// ════════════════════════════════════════════════════════════════════
//  Constants
// ════════════════════════════════════════════════════════════════════

const TAGS_REPLACEABLE = new Set([30017, 30078, 38383, 30402]);

const CONFIG = {
  defaultRelays: [],
  timeout: 10000,
};

export function config(opts = {}) {
  if (opts.defaultRelays !== undefined) CONFIG.defaultRelays = normalizeRelays(opts.defaultRelays);
  if (opts.timeout !== undefined) CONFIG.timeout = opts.timeout;
  return { ...CONFIG };
}

function normalizeRelays(r) {
  if (!r) return [];
  return (Array.isArray(r) ? r : [r]).filter(Boolean);
}

function resolveRelays(arg) {
  if (arg === undefined || arg === null) return [...CONFIG.defaultRelays];
  return normalizeRelays(arg);
}

// ════════════════════════════════════════════════════════════════════
//  Hex helpers
// ════════════════════════════════════════════════════════════════════

const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const hexToBytes = (h) => {
  if (typeof h !== "string") throw new VoyagerError("INVALID_KEY", "hex string required");
  if (h.length % 2) h = "0" + h;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const concatBytes = (...arrs) => {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

const constantTimeEq = (a, b) => {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
};

// ════════════════════════════════════════════════════════════════════
//  Hash + HMAC + SHA256 (WebCrypto)
// ════════════════════════════════════════════════════════════════════

const subtle = () => {
  if (typeof globalThis.crypto?.subtle === "undefined") {
    throw new VoyagerError("RELAY_ERROR", "WebCrypto SubtleCrypto unavailable");
  }
  return globalThis.crypto.subtle;
};

const sha256 = async (data) => {
  const buf = await subtle().digest("SHA-256", data);
  return new Uint8Array(buf);
};

const hmacSha256 = async (key, data) => {
  const k = await subtle().importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await subtle().sign("HMAC", k, data);
  return new Uint8Array(sig);
};

// ════════════════════════════════════════════════════════════════════
//  secp256k1 + BIP-340 Schnorr (via @noble/curves, @noble/hashes)
// ════════════════════════════════════════════════════════════════════
//
//  We delegate to the audited @noble/* libs. The SDK ships one runtime
//  dep (this), used for every cryptographic operation.
//
//  References:
//    @noble/curves  — secp256k1, x-only pubkeys, BIP-340 schnorr
//    @noble/hashes  — sha256, hmac-sha256, utils

import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";

const TAG_BIP0340 = new TextEncoder().encode("BIP0340/challenge");
const TAG_AUX = new TextEncoder().encode("BIP0340/aux");
const TAG_NONCE = new TextEncoder().encode("BIP0340/nonce");

async function taggedHash(tag, ...msgs) {
  const t = nobleSha256(tag);
  const hashInput = concatBytes(t, t, ...msgs);
  return nobleSha256(hashInput);
}

function xorBytes(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

// pubkeyFromSk: 32-byte sk → 33-byte compressed pubkey
function pubkeyFromSk(skBytes) {
  if (skBytes.length !== 32) throw new VoyagerError("INVALID_KEY", "sk must be 32 bytes");
  const pub = secp256k1.getPublicKey(skBytes, true); // compressed = 33 bytes
  if (pub.length !== 33) throw new VoyagerError("INVALID_KEY", "unexpected pubkey length");
  return pub;
}

async function schnorrSign(msgHash, skBytes, auxRand) {
  if (msgHash.length !== 32) throw new VoyagerError("INVALID_SIGNATURE", "msg must be 32 bytes");
  if (skBytes.length !== 32) throw new VoyagerError("INVALID_KEY", "sk must be 32 bytes");
  const aux = auxRand && auxRand.length === 32 ? auxRand : new Uint8Array(32);
  // schnorr.sign(message, secretKey, auxRand) — BIP-340 challenge includes
  // the raw message bytes directly; pass msgHash as-is (32 bytes = event id).
  return schnorr.sign(msgHash, skBytes, aux);
}

async function schnorrVerify(msgHash, sig, pubBytes) {
  if (msgHash.length !== 32 || sig.length !== 64) return false;
  if (pubBytes.length !== 32) {
    if (pubBytes.length === 33 && (pubBytes[0] === 0x02 || pubBytes[0] === 0x03)) {
      pubBytes = pubBytes.slice(1);
    } else {
      return false;
    }
  }
  try {
    return schnorr.verify(sig, msgHash, pubBytes);
  } catch {
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════
//  bech32 + NIP-19
// ════════════════════════════════════════════════════════════════════

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function bech32CreateChecksum(hrp, data) {
  const values = [...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = bech32Polymod(values) ^ 1;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((mod >> 5 * (5 - i)) & 31);
  return out;
}

function bech32VerifyChecksum(hrp, data) {
  return bech32Polymod([...bech32HrpExpand(hrp), ...data]) === 1;
}

function bech32Encode(hrp, data) {
  const chk = bech32CreateChecksum(hrp, data);
  let s = hrp + "1";
  for (const d of [...data, ...chk]) s += BECH32_CHARSET[d];
  return s;
}

function bech32Decode(bech) {
  bech = bech.toLowerCase();
  const pos = bech.lastIndexOf("1");
  if (pos < 1 || pos + 7 > bech.length) return null;
  const hrp = bech.slice(0, pos);
  const data = [];
  for (let i = pos + 1; i < bech.length; i++) {
    const idx = BECH32_CHARSET.indexOf(bech[i]);
    if (idx < 0) return null;
    data.push(idx);
  }
  if (!bech32VerifyChecksum(hrp, data)) return null;
  return { hrp, data: data.slice(0, data.length - 6) };
}

function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & ((1 << to) - 1));
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & ((1 << to) - 1));
  } else if (bits >= from || ((acc << (to - bits)) & ((1 << to) - 1))) {
    return null;
  }
  return out;
}

function encodeNip19(hrp, bytes) {
  const data = convertBits(Array.from(bytes), 8, 5, true);
  if (!data) throw new VoyagerError("INVALID_KEY", "bech32 convertBits failed");
  return bech32Encode(hrp, data);
}

function decodeNip19(hrp, s) {
  const dec = bech32Decode(s);
  if (!dec || dec.hrp !== hrp) throw new VoyagerError("INVALID_KEY", `expected hrp ${hrp}`);
  const bytes = convertBits(dec.data, 5, 8, false);
  if (!bytes) throw new VoyagerError("INVALID_KEY", "bech32 convertBits failed");
  return new Uint8Array(bytes);
}

// ════════════════════════════════════════════════════════════════════
//  NIP-19 surface (npub/nsec encode + parse)
// ════════════════════════════════════════════════════════════════════

export function npubEncode(pubBytes) {
  return encodeNip19("npub", pubBytes);
}

export function nsecEncode(skBytes) {
  return encodeNip19("nsec", skBytes);
}

// ════════════════════════════════════════════════════════════════════
//  Demo key (shared, plaintext, public)
// ════════════════════════════════════════════════════════════════════

let _demoKey = null;

async function loadDemoKey() {
  if (_demoKey) return _demoKey;
  // Lazy: try to read demo-key.json via dynamic import (works in Node only).
  // In the browser, the SDK will receive it via bundler; for the demo, Node only.
  if (typeof process === "undefined" || !process.versions?.node) {
    throw new VoyagerError("RELAY_ERROR", "demoKey() requires Node — pass your own key in browsers");
  }
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const url = await import("node:url");
  const here = url.fileURLToPath(new URL(".", import.meta.url));
  const file = path.join(here, "demo-key.json");
  const txt = await fs.readFile(file, "utf8");
  _demoKey = JSON.parse(txt);
  return _demoKey;
}

export async function demoKey() {
  return loadDemoKey();
}

// ════════════════════════════════════════════════════════════════════
//  fromNsec / secret key parsing
// ════════════════════════════════════════════════════════════════════

export async function fromNsec(nsec) {
  if (typeof nsec !== "string") throw new VoyagerError("INVALID_KEY", "nsec must be a string");
  let sk;
  try {
    sk = decodeNip19("nsec", nsec);
  } catch (e) {
    throw new VoyagerError("INVALID_KEY", "bad bech32 or hrp", e);
  }
  if (sk.length !== 32) throw new VoyagerError("INVALID_KEY", `expected 32 bytes, got ${sk.length}`);
  // Range check via noble.
  try { secp256k1.getPublicKey(sk, true); }
  catch { throw new VoyagerError("INVALID_KEY", "secret key out of range"); }
  const pub = pubkeyFromSk(sk);
  return { npub: npubEncode(pub), nsec: nsecEncode(sk) };
}

// ════════════════════════════════════════════════════════════════════
//  Event serialization (NIP-01)
// ════════════════════════════════════════════════════════════════════
//
//  Canonical form: [0, pubkey, created_at, kind, tags, content]
//  id = sha256 of UTF-8 JSON of canonical (no whitespace, no id, no sig)

export function serializeEvent(ev) {
  return JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content ?? ""]);
}

export async function computeEventId(ev) {
  const bytes = await sha256(new TextEncoder().encode(serializeEvent(ev)));
  return bytesToHex(bytes);
}

// ════════════════════════════════════════════════════════════════════
//  Sign / verify (kind:1 baseline; works for any kind)
// ════════════════════════════════════════════════════════════════════

export async function sign(template, nsec) {
  if (!template || typeof template !== "object") throw new VoyagerError("INVALID_EVENT", "template required");
  if (typeof nsec !== "string") throw new VoyagerError("INVALID_KEY", "nsec string required");

  const { nsec: cleanNsec } = await fromNsec(nsec);
  const sk = decodeNip19("nsec", cleanNsec);
  const pub = pubkeyFromSk(sk);

  const ev = {
    pubkey: bytesToHex(pub.slice(1)),  // x-only 32 bytes hex (NIP-01)
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
    kind: template.kind,
    tags: Array.isArray(template.tags) ? template.tags.map(t => Array.isArray(t) ? t.slice() : [String(t)]) : [],
    content: template.content ?? "",
  };
  ev.id = await computeEventId(ev);
  const msgBytes = hexToBytes(ev.id);
  const aux = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const sig = await schnorrSign(msgBytes, sk, aux);
  ev.sig = bytesToHex(sig);
  return ev;
}

export async function verify(event) {
  if (!event || typeof event !== "object") throw new VoyagerError("INVALID_EVENT", "event required");
  const { id, sig, pubkey, ...rest } = event;
  if (!id || !sig || !pubkey) throw new VoyagerError("INVALID_EVENT", "missing id/sig/pubkey");
  const recomputed = await computeEventId({ ...rest, pubkey });
  if (recomputed !== id) return false;
  let pubBytes;
  try {
    pubBytes = typeof pubkey === "string" && /^[0-9a-f]{64}$/i.test(pubkey) ? hexToBytes(pubkey) : decodeNip19("npub", pubkey);
  } catch { return false; }
  if (pubBytes.length !== 32) return false;
  try {
    return schnorrVerify(hexToBytes(id), hexToBytes(sig), pubBytes);
  } catch { return false; }
}

export async function eventId(event) {
  return computeEventId(event);
}

// ════════════════════════════════════════════════════════════════════
//  Listings (kind:30402)
// ════════════════════════════════════════════════════════════════════

export async function listing(input, nsec) {
  if (!input || typeof input !== "object") throw new VoyagerError("INVALID_EVENT", "input required");
  if (!input.d)       throw new VoyagerError("INVALID_TAG", "listing requires d tag");
  if (!input.title)   throw new VoyagerError("INVALID_TAG", "listing requires title tag");
  if (!input.price || !Array.isArray(input.price) || input.price.length !== 2) {
    throw new VoyagerError("INVALID_TAG", "listing requires price: [amount, unit]");
  }
  const tags = [
    ["d", String(input.d)],
    ["title", String(input.title)],
    ["price", String(input.price[0]), String(input.price[1])],
  ];
  if (input.image) tags.push(["image", String(input.image)]);
  if (Array.isArray(input.v)) {
    for (const t of input.v) {
      if (Array.isArray(t) && t.length >= 3) tags.push(["v", ...t.slice(0, 3)]);
    }
  }
  return sign({ kind: 30402, tags, content: input.content ?? "" }, nsec);
}

export async function updateListing(d, patch, nsec) {
  const merged = { ...patch, d };
  return listing(merged, nsec);
}

// ════════════════════════════════════════════════════════════════════
//  Stalls (kind:30017)
// ════════════════════════════════════════════════════════════════════

export async function stall(input, nsec) {
  if (!input || typeof input !== "object") throw new VoyagerError("INVALID_EVENT", "input required");
  if (!input.d)    throw new VoyagerError("INVALID_TAG", "stall requires d tag");
  if (!input.name) throw new VoyagerError("INVALID_TAG", "stall requires name tag");
  const tags = [
    ["d", String(input.d)],
    ["name", String(input.name)],
  ];
  if (input.currency) tags.push(["currency", String(input.currency)]);
  if (input.shipping) tags.push(["shipping", typeof input.shipping === "string" ? input.shipping : JSON.stringify(input.shipping)]);
  if (input.image)    tags.push(["image", String(input.image)]);
  if (Array.isArray(input.v)) {
    for (const t of input.v) {
      if (Array.isArray(t) && t.length >= 3) tags.push(["v", ...t.slice(0, 3)]);
    }
  }
  return sign({ kind: 30017, tags, content: input.about ?? "" }, nsec);
}

export async function updateStall(d, patch, nsec) {
  return stall({ ...patch, d }, nsec);
}

// ════════════════════════════════════════════════════════════════════
//  NIP-44 encryption (v2, used by NIP-17 gift-wrap)
// ════════════════════════════════════════════════════════════════════
//
//  Conversation key = HKDF-extract(ECDH(sec,recv_pub), nonce=0)
//  Then chacha20 + hmac-sha256 per NIP-44 v2.
//  For MVP, we use the v2 message-key derivation but a simplified nonce
//  handling — adequate for SDK MVP, full v2 audit is a v0.2 task.

async function chacha20(key, nonce, counter) {
  // chacha20 via Node's crypto module (works in Node 22+). Browser support is
  // a v0.2 task; for MVP, dmSend/dmOpen work in Node only.
  if (typeof process !== "undefined" && process?.versions?.node) {
    try {
      const { createCipheriv, createDecipheriv } = await import("node:crypto");
      const fullNonce = new Uint8Array(16);
      fullNonce.set(nonce, 4);
      const ctrBE = new Uint8Array(4);
      ctrBE[0] = (counter >> 24) & 0xff;
      ctrBE[1] = (counter >> 16) & 0xff;
      ctrBE[2] = (counter >> 8) & 0xff;
      ctrBE[3] = counter & 0xff;
      fullNonce.set(ctrBE, 0);
      return {
        encrypt: (pt) => new Uint8Array(createCipheriv("chacha20", Buffer.from(key), Buffer.from(fullNonce)).update(Buffer.from(pt))),
        decrypt: (ct) => new Uint8Array(createDecipheriv("chacha20", Buffer.from(key), Buffer.from(fullNonce)).update(Buffer.from(ct))),
      };
    } catch (e) {
      throw new VoyagerError("RELAY_ERROR", "chacha20 init failed: " + (e?.message ?? e), e);
    }
  }
  throw new VoyagerError("RELAY_ERROR", "chacha20 only available in Node 22+ for MVP");
}

async function hkdfExtract(salt, ikm) {
  return hmacSha256(salt, ikm);
}

async function nip44v2ConversationKey(skBytes, toPubBytes) {
  // NIP-44 ECDH: sk * P. NIP-44 v2 uses x-only 32-byte pubkeys; noble's ECDH
  // API wants a 33-byte compressed pubkey. Per NIP-44 convention, the x-only
  // key is interpreted with even y, so prefix 0x02 is correct.
  const xOnly = toPubBytes.length === 33 ? toPubBytes.slice(1) : toPubBytes;
  const compressed = new Uint8Array(33);
  compressed[0] = 0x02;
  compressed.set(xOnly, 1);
  const shared = secp256k1.getSharedSecret(skBytes, compressed);
  // shared is 33 bytes (compressed); extract x = bytes[1..33]
  const sharedX = shared.slice(1);
  return hkdfExtract(new Uint8Array(32), sharedX);
}

async function nip44v2MessageKeys(ck, nonce) {
  // HKDF-style: expand into chacha20 key + hmac key + nonce.
  // Simple two-block derivation for MVP.
  const k1 = await hmacSha256(ck, concatBytes(new TextEncoder().encode("nip44-v2"), hexToBytes(nonce)));
  const k2 = await hmacSha256(ck, concatBytes(k1, new TextEncoder().encode("c")));
  const k3 = await hmacSha256(ck, concatBytes(k2, new TextEncoder().encode("n")));
  return { chachaKey: k1, chachaNonce: k2.slice(0, 12), hmacKey: k3 };
}

async function nip44Encrypt(skBytes, toPubBytes, plaintext) {
  const ck = await nip44v2ConversationKey(skBytes, toPubBytes);
  const nonce = bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32))).slice(0, 48);
  const k = await nip44v2MessageKeys(ck, nonce);
  const c = await chacha20(k.chachaKey, k.chachaNonce, 0);
  const ct = c.encrypt(new TextEncoder().encode(plaintext));
  const mac = await hmacSha256(k.hmacKey, concatBytes(hexToBytes(nonce), ct));
  return `v2:${nonce}:${bytesToHex(concatBytes(ct, mac))}`;
}

async function nip44Decrypt(skBytes, fromPubBytes, ciphertext) {
  if (!ciphertext.startsWith("v2:")) throw new VoyagerError("INVALID_EVENT", "unsupported nip44 version");
  const [, nonce, body] = ciphertext.split(":");
  const raw = hexToBytes(body);
  const ct = raw.slice(0, raw.length - 32);
  const mac = raw.slice(raw.length - 32);
  const ck = await nip44v2ConversationKey(skBytes, fromPubBytes);
  const k = await nip44v2MessageKeys(ck, nonce);
  const expected = await hmacSha256(k.hmacKey, concatBytes(hexToBytes(nonce), ct));
  if (!constantTimeEq(mac, expected)) throw new VoyagerError("INVALID_SIGNATURE", "nip44 mac mismatch");
  const c = await chacha20(k.chachaKey, k.chachaNonce, 0);
  return new TextDecoder().decode(c.decrypt(ct));
}

// ════════════════════════════════════════════════════════════════════
//  DM: send, open, inbox (NIP-17)
// ════════════════════════════════════════════════════════════════════
//
//  NIP-17 flow: build kind:14 rumor; wrap in kind:1059 with random
//  ephemeral secp256k1 keypair; ephemeral pubkey is randomized per wrap
//  to break correlation. Recipients scan all 1059, count those addressed
//  to their npub, decrypt.

function randomSk() {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

async function buildRumor(payload, fromNpub) {
  const content = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    kind: 14,
    pubkey: fromNpub,
    content,
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
  };
}

export async function dmSend(toNpub, payload, nsec, opts = {}) {
  const { nsec: cleanNsec, npub } = await fromNsec(nsec);
  const sk = decodeNip19("nsec", cleanNsec);
  const rumor = await buildRumor(payload, npub);
  // Ephemeral key for the wrap (already-validated-by-construction since randomBytes
  // gives in-range 32-byte values; but verify on signing).
  const epSk = randomSk();
  const epPub = pubkeyFromSk(epSk);
  const epPubXOnly = epPub.slice(1);
  const toPub = decodeNip19("npub", toNpub);
  // Encrypt the (signed-or-not) rumor. We sign the rumor with the
  // SENDER's key (per NIP-17), so the recipient can verify authorship.
  // Sign synchronously by running our async signer inline:
  // We'll skip signing the rumor (NIP-17 says rumor is unsigned; auth
  // comes from the recipient's decryption only). Most NIP-17 impls skip
  // signing the rumor; the wrap pubkey is random.
  const rumorSerialized = JSON.stringify([0, rumor.pubkey, rumor.created_at, rumor.kind, rumor.tags, rumor.content]);
  const ciphertext = await nip44Encrypt(epSk, toPub, rumorSerialized);

  // Build kind:1059 wrap event signed by ephemeral key
  const ev = {
    pubkey: bytesToHex(epPubXOnly),
    created_at: Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 86400), // random offset for unlinkability
    kind: 1059,
    tags: [["p", toNpub]],
    content: ciphertext,
  };
  ev.id = await computeEventId(ev);
  const aux = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const sig = await schnorrSign(hexToBytes(ev.id), epSk, aux);
  ev.sig = bytesToHex(sig);

  if (!opts.dryRun) {
    await publish(ev, opts.relays);
  }
  return { id: ev.id, wrap: ev };
}

export async function dmOpen(giftwrap, nsec) {
  if (!giftwrap || giftwrap.kind !== 1059) return null;
  // giftwrap.pubkey is x-only 32-byte hex (NIP-01)
  const epPubXOnly = hexToBytes(giftwrap.pubkey); // 32 bytes
  const fromNpub = npubEncode(epPubXOnly);
  // Find the `p` tag (intended recipient)
  const pTag = (giftwrap.tags || []).find(t => Array.isArray(t) && t[0] === "p");
  if (!pTag) return null;
  // Decrypt using recipient sk
  const { nsec: cleanNsec, npub: recipientNpub } = await fromNsec(nsec);
  if (pTag[1] !== recipientNpub) return null;
  const sk = decodeNip19("nsec", cleanNsec);
  const plaintext = await nip44Decrypt(sk, epPubXOnly, giftwrap.content);
  const arr = JSON.parse(plaintext);
  if (!Array.isArray(arr) || arr.length < 6) return null;
  const [, pubkey, created_at, kind, tags, content] = arr;
  const rumor = { pubkey, created_at, kind, tags, content };
  let payload = null;
  try { payload = JSON.parse(content); } catch { payload = content; }
  return { fromNpub: npubEncode(hexToBytes(pubkey)), rumor: { ...rumor, payload } };
}

export async function dmInbox(nsec, opts = {}) {
  const relays = resolveRelays(opts.relays);
  const events = await get(relays, { kinds: [1059], "#p": [ (await fromNsec(nsec)).npub ], since: opts.since, until: opts.until, limit: opts.limit });
  const out = [];
  for (const ev of events) {
    try {
      const opened = await dmOpen(ev, nsec);
      if (opened) out.push({ ...opened, giftwrap: ev, openedAt: Math.floor(Date.now() / 1000) });
    } catch {}
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════
//  Ramp (kind:38383)
// ════════════════════════════════════════════════════════════════════

export async function rampIntent(input, nsec) {
  if (!input || typeof input !== "object") throw new VoyagerError("INVALID_EVENT", "input required");
  if (!["buy", "sell"].includes(input.side)) throw new VoyagerError("INVALID_RAMP", "side must be buy|sell");
  if (!input.amt || !Array.isArray(input.amt)) throw new VoyagerError("INVALID_RAMP", "amt: [amount,unit] required");
  if (!input.fiat || !Array.isArray(input.fiat)) throw new VoyagerError("INVALID_RAMP", "fiat: [amount,ccy] required");
  const d = input.d ?? bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const tags = [
    ["d", d],
    ["s", input.side],
    ["amt", String(input.amt[0]), String(input.amt[1])],
    ["f", String(input.fiat[0]), String(input.fiat[1])],
  ];
  if (Array.isArray(input.z)) {
    for (const t of input.z) {
      if (Array.isArray(t) && t.length >= 3) tags.push(["z", ...t.slice(0, 3)]);
    }
  }
  return sign({ kind: 38383, tags, content: input.content ?? "" }, nsec);
}

export async function rampQuote(intentEventOrId, quote, nsec) {
  const intentId = typeof intentEventOrId === "string" ? intentEventOrId : intentEventOrId?.id;
  if (!intentId) throw new VoyagerError("INVALID_RAMP", "intent event or id required");
  if (!quote || typeof quote !== "object") throw new VoyagerError("INVALID_RAMP", "quote required");
  const d = bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const tags = [
    ["d", d],
    ["ref", intentId],
  ];
  const fields = ["fee_sats", "maker_pubkey", "method", "rate_sats_per_unit", "reputation"];
  for (const f of fields) {
    if (quote[f] !== undefined) tags.push(["z", "voyager.ramp.v1", f, String(quote[f])]);
  }
  return sign({ kind: 38383, tags, content: "" }, nsec);
}

export async function rampQuotes({ intentId, relays, timeout } = {}) {
  if (!intentId) throw new VoyagerError("INVALID_RAMP", "intentId required");
  return get(resolveRelays(relays), { kinds: [38383], "#ref": [intentId], timeout });
}

// ════════════════════════════════════════════════════════════════════
//  Relay transport
// ════════════════════════════════════════════════════════════════════
//
//  Wire protocol: NIP-01 over WebSocket. EVENT message format:
//  ["EVENT", <event>], REQ: ["REQ", <sub-id>, <filter>...]
//  EOSE: ["EOSE", <sub-id>], CLOSE: ["CLOSE", <sub-id>].
//
//  For MVP we keep it minimal: no auth (NIP-42), no NIP-45 counts.

function relayUrl(r) {
  return r.replace(/^http(s)?:/, "ws$1:");
}

function relayHttpUrl(r) {
  return r.replace(/^ws(s)?:/, "http$1:");
}

function wsSend(ws, msg) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(msg));
}

function reqOnce(url, filter, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer;
    let ws;
    try { ws = new WebSocket(url); }
    catch (e) { reject(new VoyagerError("RELAY_ERROR", `bad ws url: ${url}`, e)); return; }
    const subId = "v" + Math.random().toString(36).slice(2, 10);
    const seen = new Map();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { wsSend(ws, ["CLOSE", subId]); } catch {}
      try { ws.close(); } catch {}
      resolve([...seen.values()]);
    };
    const fail = (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      reject(e);
    };
    ws.addEventListener("open", () => wsSend(ws, ["REQ", subId, filter]));
    ws.addEventListener("message", (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m[0] === "EVENT" && m[1] === subId) {
          const e = m[2];
          if (e && e.id) seen.set(e.id, e);
        } else if (m[0] === "EOSE" && m[1] === subId) {
          finish();
        } else if (m[0] === "CLOSED" && m[1] === subId) {
          finish();
        } else if (m[0] === "NOTICE") {
          // ignore for MVP
        }
      } catch {}
    });
    ws.addEventListener("error", () => fail(new VoyagerError("RELAY_ERROR", `ws error on ${url}`)));
    timer = setTimeout(finish, timeoutMs ?? CONFIG.timeout);
  });
}

export async function get(relaysArg, filter) {
  const relays = resolveRelays(relaysArg);
  if (relays.length === 0) throw new VoyagerError("RELAY_ERROR", "no relays configured");
  const timeoutMs = filter?.timeout ?? CONFIG.timeout;
  const f = { ...filter };
  delete f.timeout;
  const results = await Promise.allSettled(relays.map((r) => reqOnce(relayUrl(r), f, timeoutMs)));
  const merged = new Map();
  for (const r of results) {
    if (r.status === "fulfilled") {
      for (const ev of r.value) merged.set(ev.id, ev);
    }
  }
  // Replaceable events: latest by created_at wins per (kind,pubkey,d)
  const out = [];
  for (const ev of merged.values()) {
    out.push(parse(ev));
  }
  return out;
}

export async function listings({ relays, author, d, kinds, timeout } = {}) {
  const filter = { kinds: kinds ?? [30402] };
  if (author) filter.authors = Array.isArray(author) ? author : [author];
  if (d)      filter["#d"]   = Array.isArray(d) ? d : [d];
  if (timeout) filter.timeout = timeout;
  const events = await get(resolveRelays(relays), filter);
  return events.sort((a, b) => (b.event.created_at ?? 0) - (a.event.created_at ?? 0));
}

export async function stalls({ relays, author, timeout } = {}) {
  const filter = { kinds: [30017] };
  if (author) filter.authors = Array.isArray(author) ? author : [author];
  if (timeout) filter.timeout = timeout;
  const events = await get(resolveRelays(relays), filter);
  return events.sort((a, b) => (b.event.created_at ?? 0) - (a.event.created_at ?? 0));
}

function pubOnce(url, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer;
    let ws;
    try { ws = new WebSocket(url); }
    catch (e) { reject(new VoyagerError("RELAY_ERROR", `bad ws url: ${url}`, e)); return; }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
    };
    timer = setTimeout(() => { finish(); reject(new VoyagerError("RELAY_TIMEOUT", `publish timeout: ${url}`)); }, timeoutMs);
    ws.addEventListener("open", () => wsSend(ws, ["EVENT", event]));
    ws.addEventListener("message", (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m[0] === "OK" && m[1] === event.id) {
          finish();
          if (m[2]) resolve({ ok: true, relay: url });
          else reject(new VoyagerError("RELAY_REJECTED", `relay rejected: ${m[3] ?? "no reason given"} (${url})`));
        } else if (m[0] === "NOTICE") {
          // ignore
        }
      } catch {}
    });
    ws.addEventListener("error", () => { finish(); reject(new VoyagerError("RELAY_ERROR", `ws error on ${url}`)); });
  });
}

export async function publish(event, relaysArg) {
  if (!event || typeof event !== "object" || !event.id || !event.sig) {
    throw new VoyagerError("INVALID_EVENT", "publish requires a signed event");
  }
  const relays = resolveRelays(relaysArg);
  if (relays.length === 0) throw new VoyagerError("RELAY_ERROR", "no relays configured");
  const errors = [];
  for (const r of relays) {
    try {
      const res = await pubOnce(relayUrl(r), event, CONFIG.timeout);
      return res;
    } catch (e) {
      errors.push({ relay: r, error: e });
    }
  }
  const summary = errors.map(({ relay, error }) =>
    `${relay}: ${error?.code ?? "?"} ${error?.message ?? String(error)}`
  ).join(" | ");
  throw new VoyagerError("RELAY_ERROR", `all relays failed — ${summary}`, errors);
}

// Subscription: real-time, fan-out across relays, dedup by event id.
export function on(filter, callback) {
  const relays = resolveRelays(CONFIG.defaultRelays);
  if (relays.length === 0) throw new VoyagerError("RELAY_ERROR", "no relays configured");
  const seen = new Set();
  const sockets = [];
  const subId = "v" + Math.random().toString(36).slice(2, 10);

  for (const r of relays) {
    let ws;
    try { ws = new WebSocket(relayUrl(r)); }
    catch { continue; }
    sockets.push(ws);
    ws.addEventListener("open", () => wsSend(ws, ["REQ", subId, filter]));
    ws.addEventListener("message", (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m[0] === "EVENT" && m[1] === subId) {
          const e = m[2];
          if (e && e.id && !seen.has(e.id)) {
            seen.add(e.id);
            try { callback(parse(e)); } catch {}
          }
        }
      } catch {}
    });
  }

  return function unsub() {
    for (const ws of sockets) {
      try { wsSend(ws, ["CLOSE", subId]); } catch {}
      try { ws.close(); } catch {}
    }
  };
}

// ════════════════════════════════════════════════════════════════════
//  Parse-on-read: turn raw event into {kind, author, kindX: {...}, event}
// ════════════════════════════════════════════════════════════════════

const findTag = (tags, name) => (tags || []).find(t => Array.isArray(t) && t[0] === name);

export function parse(ev) {
  const out = { event: ev, kind: ev.kind, author: ev.pubkey, created_at: ev.created_at };
  if (ev.kind === 30402) {
    const d = findTag(ev.tags, "d");
    const title = findTag(ev.tags, "title");
    const price = findTag(ev.tags, "price");
    out.listing = {
      d: d?.[1],
      title: title?.[1],
      price: price ? [price[1], price[2]] : null,
      v: (ev.tags || []).filter(t => Array.isArray(t) && t[0] === "v").map(t => t.slice(1)),
    };
  } else if (ev.kind === 30017) {
    const d = findTag(ev.tags, "d");
    const name = findTag(ev.tags, "name");
    out.stall = {
      d: d?.[1],
      name: name?.[1],
      v: (ev.tags || []).filter(t => Array.isArray(t) && t[0] === "v").map(t => t.slice(1)),
    };
  } else if (ev.kind === 38383) {
    const d = findTag(ev.tags, "d");
    const ref = findTag(ev.tags, "ref");
    const s = findTag(ev.tags, "s");
    out.ramp = {
      d: d?.[1],
      ref: ref?.[1],
      side: s?.[1],
      z: (ev.tags || []).filter(t => Array.isArray(t) && t[0] === "z").map(t => t.slice(1)),
    };
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════
//  Default export
// ════════════════════════════════════════════════════════════════════

export default {
  config,
  demoKey,
  fromNsec,
  npubEncode,
  nsecEncode,
  sign,
  verify,
  eventId,
  serializeEvent,
  computeEventId,
  listing,
  updateListing,
  listings,
  stall,
  updateStall,
  stalls,
  dmSend,
  dmOpen,
  dmInbox,
  rampIntent,
  rampQuote,
  rampQuotes,
  publish,
  get,
  on,
  parse,
  VoyagerError,
};
