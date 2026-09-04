import * as v from "./voyager.js";

const me = await v.demoKey();
console.log("demoKey:", me);

const parsed = await v.fromNsec(me.nsec);
console.log("fromNsec:", parsed);

const ev = await v.sign({ kind: 1, content: "hello" }, me.nsec);
console.log("sign:", ev);

console.log("verify (good):", await v.verify(ev));
console.log("verify (bad):", await v.verify({ ...ev, content: "tampered" }));

const listing = await v.listing({
  d: "snapper-001",
  title: "Fresh whole snapper",
  price: ["42000", "sats"],
  v: [["voyager.listing.v1", "shipping_zone", "caribbean"]],
}, me.nsec);
console.log("listing:", listing);

const stall = await v.stall({ d: "isabel-fish", name: "Isabel's Fish", currency: "sats" }, me.nsec);
console.log("stall:", stall);

const intent = await v.rampIntent({
  side: "buy",
  amt: ["50000", "sats"],
  fiat: ["2500", "JMD"],
}, me.nsec);
console.log("rampIntent:", intent);

const quote = await v.rampQuote(intent, {
  fee_sats: "500",
  maker_pubkey: me.npub,
  method: "wise",
  rate_sats_per_unit: "20",
  reputation: "0.92",
}, me.nsec);
console.log("rampQuote:", quote);

const dm = await v.dmSend(me.npub, { type: "hello", msg: "first DM" }, me.nsec, { dryRun: true });
console.log("dmSend:", dm);

const opened = await v.dmOpen(dm.wrap, me.nsec);
console.log("dmOpen:", opened);

console.log("parse(listing):", v.parse(listing));
console.log("parse(stall):", v.parse(stall));
console.log("parse(intent):", v.parse(intent));
console.log("parse(quote):", v.parse(quote));

v.config({ defaultRelays: ["wss://relay.damus.io"], timeout: 10000 });
console.log("config:", v.config());
