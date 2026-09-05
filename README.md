# voyager-sdk

Voyager Protocol SDK — Nostr-native, Lightning, Mostro. Lean. No AI. No telemetry.

Spec:           [VOYAGER_RFC.md](https://voyager.network/rfc) (kinds 30402, 30017, 14, 1059, 38383)
Design:         SDK_MVP_DESIGN.md (the design contract this SDK implements)
NIPs used:      NIP-01 (events), NIP-19 (bech32), NIP-44 (encryption), NIP-17 (gift-wrap), NIP-33 (replaceable)

## Install

Drop `voyager.js` into your project and import it:

```js
import * as voyager from "./voyager.js";
```

## Quick start

```js
import * as voyager from "./voyager.js";

// Configure once at app entry (optional)
voyager.config({
  defaultRelays: ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.nostr.band"],
  timeout: 10000,
});

// The shared demo key — for exploration only.
const me = await voyager.demoKey();

// Or import your own nsec (from a hardware signer, NIP-46 remote signer, etc.):
// const me = await voyager.fromNsec("nsec1...");

// Create a listing (kind 30402)
const listing = await voyager.listing({
  d: "snapper-001",
  title: "Fresh whole snapper",
  price: ["42000", "sats"],
  v: [["voyager.listing.v1", "shipping_zone", "caribbean"]],
}, me.nsec);

// Publish to the configured relays
await voyager.publish(listing);

// Read listings — fans out across relays, merges by event id
const listings = await voyager.listings({ author: someVendorNpub });

// Subscribe to live events
const unsub = voyager.on({ kinds: [30402], authors: [someVendorNpub] }, (ev) => {
  console.log("new listing:", ev);
});
// Later: unsub();

// Send a NIP-17 gift-wrapped DM
await voyager.dmSend(recipientNpub, { type: "order_request", items: [...] }, me.nsec);
```

## The full API

### Identity
- `voyager.demoKey()` → `{npub, nsec}` — shared demo keypair.
- `voyager.fromNsec(nsec)` → `{npub, nsec}` — parse + validate user-provided key.

### Signing + verification
- `voyager.sign(template, nsec)` → signed Nostr event
- `voyager.verify(event)` → boolean
- `voyager.eventId(event)` → sha256 hex
- `voyager.serializeEvent(event)` → canonical JSON

### Listings (kind 30402)
- `voyager.listing(input, nsec)` → signed event
- `voyager.updateListing(d, patch, nsec)` → signed event (replaces)
- `voyager.listings({ relays, author, d, kinds, timeout })` → `[{d, title, price, v, event}]`

### Stalls (kind 30017)
- `voyager.stall(input, nsec)` → signed event
- `voyager.updateStall(d, patch, nsec)`
- `voyager.stalls({ relays, author, timeout })` → `[{d, name, ...}]`

### DMs (NIP-17)
- `voyager.dmSend(toNpub, payload, nsec, { relays, dryRun? })` → `{id, wrap}`
- `voyager.dmOpen(giftwrap, nsec)` → `{fromNpub, rumor}` or null
- `voyager.dmInbox(nsec, { relays, since, until, limit })` → `[{fromNpub, rumor, giftwrap}]`

### Ramp (kind 38383)
- `voyager.rampIntent({ side, amt, fiat, method?, z? }, nsec)` → signed intent
- `voyager.rampQuote(intentOrId, quote, nsec)` → signed quote
- `voyager.rampQuotes({ intentId, relays, timeout })` → `[quoteEvent]`

### Relay transport
- `voyager.publish(relays, event)` → `{ok, relay}` — first-OK
- `voyager.get(relays, filter)` → event | null
- `voyager.listings(...)`, `voyager.stalls(...)`, `voyager.rampQuotes(...)` — typed reads
- `voyager.on(filter, callback)` → `unsub()` — realtime subscription
- `voyager.config({ defaultRelays, timeout })` — set module-level defaults

### Misc
- `voyager.parse(event)` → `{kind, author, kindX: {...}, event}` — parsed view
- `voyager.npubEncode(pubBytes)`, `voyager.nsecEncode(skBytes)` — NIP-19 encoders
- `voyager.VoyagerError` — typed error with `.code`

## Demo

Run the end-to-end demo:

```sh
node demo.js
```

## License

MIT — see LICENSE.
