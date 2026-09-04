/**
 * Voyager SDK — demo runner.
 *
 * Exercises every public verb in-process. No relay, no network, no mocks.
 * Outputs each step to the console.
 *
 * Run:  node demo.js
 */

import * as v from "./voyager.js";

function line(label, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  console.log(`\n[ ${label} ]\n${text}`);
}

function ok(label) {
  console.log(`\n[ ${label} ]\nok`);
}

async function expectThrow(fn, code) {
  try { await fn(); return { ok: false, msg: "expected throw, got nothing" }; }
  catch (e) {
    if (e?.code !== code) return { ok: false, msg: `expected code ${code}, got ${e?.code}: ${e?.message}` };
    return { ok: true };
  }
}

async function main() {
  console.log("=== Voyager SDK demo ===");

  // 1. demoKey
  const demo = await v.demoKey();
  line("1. demoKey()", { npub: demo.npub, nsec: demo.nsec });

  // 2. fromNsec round-trip
  const parsed = await v.fromNsec(demo.nsec);
  line("2. fromNsec(demo.nsec)", { npub: parsed.npub, nsec: parsed.nsec });

  // 3. sign a generic event
  const signed = await v.sign({ kind: 1, content: "hello, voyager" }, demo.nsec);
  line("3. sign({kind:1,content:'hello'}, nsec)", {
    id: signed.id, pubkey: signed.pubkey, sig: signed.sig,
  });

  // 4. verify
  line("4a. verify(signed)", await v.verify(signed));
  line("4b. verify({...signed, content:'tampered'})", await v.verify({ ...signed, content: "tampered" }));

  // 5. computeEventId / serializeEvent
  const ev = { pubkey: signed.pubkey, created_at: signed.created_at, kind: signed.kind, tags: signed.tags, content: signed.content };
  line("5a. serializeEvent(ev)", v.serializeEvent(ev));
  line("5b. computeEventId(ev)", await v.computeEventId(ev));

  // 6. listing (kind 30402)
  const listing = await v.listing({
    d: "snapper-001",
    title: "Fresh whole snapper",
    price: ["42000", "sats"],
    v: [["voyager.listing.v1", "shipping_zone", "caribbean"]],
  }, demo.nsec);
  line("6. listing(input, nsec)", { id: listing.id, kind: listing.kind, tags: listing.tags });

  line("6b. listing(missing title) should throw", await expectThrow(
    () => v.listing({ d: "x" }, demo.nsec), "INVALID_TAG"));

  // 7. stall (kind 30017)
  const stall = await v.stall({
    d: "isabel-fish",
    name: "Isabel's Fish",
    currency: "sats",
    about: "Fresh catch daily",
  }, demo.nsec);
  line("7. stall(input, nsec)", { id: stall.id, kind: stall.kind, tags: stall.tags });

  // 8. updateListing / updateStall (full event regen, not patch-in-place)
  const update = await v.listing({
    d: "snapper-001",
    title: "Fresh whole snapper (large)",
    price: ["45000", "sats"],
    v: [["voyager.listing.v1", "shipping_zone", "caribbean"]],
  }, demo.nsec);
  line("8. updateListing via re-listing", { id: update.id, title: update.tags.find(t => t[0] === "title")?.[1] });

  // 9. rampIntent (kind 38383)
  const intent = await v.rampIntent({
    side: "buy",
    amt: ["50000", "sats"],
    fiat: ["2500", "JMD"],
    z: [["voyager.ramp.v1", "method", "wise"]],
  }, demo.nsec);
  line("9. rampIntent(input, nsec)", { id: intent.id, kind: intent.kind, tags: intent.tags });

  // 10. rampQuote
  const quote = await v.rampQuote(intent, {
    fee_sats: "500",
    maker_pubkey: demo.npub,
    method: "wise",
    rate_sats_per_unit: "20",
    reputation: "0.92",
  }, demo.nsec);
  line("10. rampQuote(intent, q, nsec)", { id: quote.id, kind: quote.kind, tags: quote.tags });

  // 11. dmSend (dryRun — no relay) and dmOpen round-trip
  const dm = await v.dmSend(demo.npub, { type: "hello", msg: "first DM" }, demo.nsec, { dryRun: true });
  line("11a. dmSend(toNpub, payload, nsec, {dryRun:true})", { id: dm.id, wrap_kind: dm.wrap.kind, wrap_pubkey: dm.wrap.pubkey });

  const opened = await v.dmOpen(dm.wrap, demo.nsec);
  line("11b. dmOpen(wrap, nsec)", opened);

  // 12. parse (read view)
  line("12a. parse(listing)", v.parse(listing));
  line("12b. parse(stall)", v.parse(stall));
  line("12c. parse(intent)", v.parse(intent));
  line("12d. parse(quote)", v.parse(quote));

  // 13. config
  v.config({ defaultRelays: ["wss://relay.damus.io", "wss://nos.lol"], timeout: 10000 });
  ok("13. config({ defaultRelays, timeout })");

  // 14. error paths
  const errors = [
    await expectThrow(() => v.fromNsec("nsec1invalid"), "INVALID_KEY"),
    await expectThrow(() => v.listing({ d: "x" }, demo.nsec), "INVALID_TAG"),
    await expectThrow(() => v.stall({ d: "x" }, demo.nsec), "INVALID_TAG"),
    await expectThrow(() => v.rampIntent({ side: "sideways", amt: ["1","sats"], fiat: ["1","USD"] }, demo.nsec), "INVALID_RAMP"),
  ];
  line("14. error paths", errors.map(e => e.ok ? "caught" : `FAIL: ${e.msg}`));

  console.log("\n=== done ===");
}

main().catch(e => {
  console.error("DEMO FAILED:", e);
  process.exit(1);
});
