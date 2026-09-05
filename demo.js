// voyager-sdk demo
//
// Loads the SDK, runs every verb, prints results.

import * as v from "./voyager.js";

// config sets module-level defaults used by publish/get/on/listings/
// stalls/dmSend/dmInbox/rampQuotes when no per-call relay list is given.
v.config({ defaultRelays: ["wss://nostr.wine", "wss://relay.primal.net", "wss://nostr.mom"], timeout: 4000 });
console.log("config:", v.config());

// demoKey returns a shared, public keypair intended for SDK exploration.
// Throws DEMO_KEY_DISABLED when NODE_ENV=production or the hostname is not local/test.
const me = await v.demoKey();
console.log("demoKey:", me);

// fromNsec parses an nsec string, validates it, returns the canonical {npub, nsec} pair.
const parsed = await v.fromNsec(me.nsec);
console.log("fromNsec:", parsed);

// sign takes {kind, content, tags, created_at} + nsec and returns a fully signed Nostr event.
const ev = await v.sign({ kind: 1, content: "hello" }, me.nsec);
console.log("sign:", ev);

// verify checks the Schnorr signature against the event id and pubkey.
console.log("verify (good):", await v.verify(ev));
console.log("verify (bad):", await v.verify({ ...ev, content: "tampered" }));

// listing builds a kind:30402 event. v tags pass through as raw arrays.
const listing = await v.listing({
  d: "snapper-001",
  title: "Fresh whole snapper",
  price: ["42000", "sats"],
  v: [["voyager.listing.v1", "shipping_zone", "caribbean"]],
}, me.nsec);
console.log("listing:", listing);

// stall builds a kind:30017 storefront event.
const stall = await v.stall({ d: "isabel-fish", name: "Isabel's Fish", currency: "sats" }, me.nsec);
console.log("stall:", stall);

// rampIntent builds a kind:38383 buy/sell intent for the federated fiat ramp.
const intent = await v.rampIntent({
  side: "buy",
  amt: ["50000", "sats"],
  fiat: ["2500", "JMD"],
}, me.nsec);
console.log("rampIntent:", intent);

// rampQuote builds a kind:38383 quote pointing back at an intent's id.
const quote = await v.rampQuote(intent, {
  fee_sats: "500",
  maker_pubkey: me.npub,
  method: "wise",
  rate_sats_per_unit: "20",
  reputation: "0.92",
}, me.nsec);
console.log("rampQuote:", quote);

// dmSend builds a NIP-17 gift-wrap. dryRun skips the relay publish.
const dm = await v.dmSend(me.npub, { type: "hello", msg: "first DM" }, me.nsec, { dryRun: true });
console.log("dmSend:", dm);

// dmOpen decrypts a NIP-17 wrap using the recipient's nsec, returns the inner rumor.
const opened = await v.dmOpen(dm.wrap, me.nsec);
console.log("dmOpen:", opened);

// parse returns a friendlier view of a raw event with the kind-specific fields lifted.
console.log("parse(listing):", v.parse(listing));
console.log("parse(stall):", v.parse(stall));
console.log("parse(intent):", v.parse(intent));
console.log("parse(quote):", v.parse(quote));

// publish sends an event to the configured relays, first-OK semantics.
try {
  console.log("\npublish(listing):", await v.publish(listing));
} catch (err) {
  console.log("\npublish(listing) FAILED:");
  console.log("  message:", err?.message);
  console.log("  cause:", err?.cause);
  console.log("  config:", v.config());
  throw err;
}

// listings queries relays, fans out, merges by event id, returns the parsed shape.
console.log("listings({ author: me.npub }):", await v.listings({ author: me.npub, limit: 5 }));

// rampQuotes aggregates quotes for a given intent id.
console.log("rampQuotes({ intentId: intent.id }):", await v.rampQuotes({ intentId: intent.id, limit: 5 }));
