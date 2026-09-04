// voyager-sdk demo
//
// Loads the SDK, runs every verb, prints results.
// One file. One screen. No abstraction.

import * as v from "./voyager.js";

// Get a key. demoKey() returns a shared, public, worthless keypair
// for poking at the API. Throws in production.
const me = await v.demoKey();
console.log("demoKey:", me);

// Same key, parsed back from its nsec string.
// fromNsec is the validator — it returns the canonical form
// and throws on bad input.
const parsed = await v.fromNsec(me.nsec);
console.log("fromNsec:", parsed);

// Build and sign a kind:1 (short text note) event.
// sign() takes a template + nsec, returns the full signed event
// with id, pubkey, sig all filled in.
const ev = await v.sign({ kind: 1, content: "hello" }, me.nsec);
console.log("sign:", ev);

// Verify checks the signature against the event id.
// A tampered event fails. A real one passes.
console.log("verify (good):", await v.verify(ev));
console.log("verify (bad):", await v.verify({ ...ev, content: "tampered" }));

// Listings are the marketplace primitive (kind:30402).
// v-tags pass through as raw 4-string arrays — Open World Assumption.
const listing = await v.listing({
  d: "snapper-001",
  title: "Fresh whole snapper",
  price: ["42000", "sats"],
  v: [["voyager.listing.v1", "shipping_zone", "caribbean"]],
}, me.nsec);
console.log("listing:", listing);

// Stalls are the vendor storefront (kind:30017).
const stall = await v.stall({ d: "isabel-fish", name: "Isabel's Fish", currency: "sats" }, me.nsec);
console.log("stall:", stall);

// Ramp intent (kind:38383) — customer asking to buy sats with fiat.
// Side 'buy' = customer wants sats; 'sell' = customer has sats to offload.
const intent = await v.rampIntent({
  side: "buy",
  amt: ["50000", "sats"],
  fiat: ["2500", "JMD"],
}, me.nsec);
console.log("rampIntent:", intent);

// Ramp quote — a Mostro node offering to fill that intent.
const quote = await v.rampQuote(intent, {
  fee_sats: "500",
  maker_pubkey: me.npub,
  method: "wise",
  rate_sats_per_unit: "20",
  reputation: "0.92",
}, me.nsec);
console.log("rampQuote:", quote);

// NIP-17 gift-wrapped DM. dryRun: true skips the relay publish
// so this demo runs offline. In real use, drop dryRun and pass relays.
const dm = await v.dmSend(me.npub, { type: "hello", msg: "first DM" }, me.nsec, { dryRun: true });
console.log("dmSend:", dm);

// dmOpen reverses the wrap: decrypts the inner rumor with the
// recipient's secret key, returns the original message.
const opened = await v.dmOpen(dm.wrap, me.nsec);
console.log("dmOpen:", opened);

// parse() turns a raw event into a friendlier object
// with the kind-specific fields lifted to the top.
console.log("parse(listing):", v.parse(listing));
console.log("parse(stall):", v.parse(stall));
console.log("parse(intent):", v.parse(intent));
console.log("parse(quote):", v.parse(quote));

// config sets module-level defaults used by publish/get/on
// when no per-call relay list is given.
v.config({ defaultRelays: ["wss://relay.damus.io"], timeout: 10000 });
console.log("config:", v.config());
