# Voyager SDK — MVP Design (Sep 4 2026)

Status: design only, not yet built
Spec reference: /home/tk/voyager/VOYAGER_RFC.md
Audience: implementer (us) — this is the spec the SDK must satisfy

---

## Package

```
voyager-sdk
```

No scope. Plain npm name. One package, one file of code, no build step.

```
voyager-sdk/
  voyager.js       ← the entire SDK, ~400 lines
  package.json     ← no deps, "type":"module", main: "./voyager.js"
  README.md        ← one screen
  LICENSE          ← MIT
```

## Dependencies

Zero runtime. Zero dev.

- secp256k1 sign/verify — hand-rolled or inlined (~150 lines pure JS)
- chacha20, sha256, hmac-sha256 — Node's `crypto` module + browser `SubtleCrypto` + `crypto` subtle via WebCrypto where available
- bech32 (NIP-19 encoding) — hand-rolled (~40 lines)
- WebSocket — browser native `WebSocket`, Node 22+ native `WebSocket`
- `fetch` — browser native, Node 22+ native

If we decide secp256k1 hand-roll is too risky, fallback is `@noble/curves` (~30KB, audited). Open question, deferred.

## Import shape

```js
import * as voyager from 'voyager-sdk';
```

Namespace export. Caller uses `voyager.listing(...)`, `voyager.publish(...)`, etc. Discoverable by typing `voyager.` and tabbing.

## Principles (baked in)

1. **Pass the raw event shape through.** A `v` tag is a 4-string array. We do not parse it, validate the namespace, or second-guess. Open World Assumption is preserved by NEVER touching what we don't recognize.
2. **Parse-on-read, not parse-on-write.** When the caller calls `voyager.listings(...)`, we return a parsed shape. When building events, we always take the raw shape because that's what signers consume.
3. **Fan out on reads, first-OK on publish.** Reads query every relay in `relays[]`, merge by event id, dedup. Publishes try each in order until one accepts.

## What it does NOT do (MVP exclusions)

- No relay pool / reconnect logic
- No NWC (wallet connection)
- No caching layer
- No MCP / AI anything
- No test framework baked in (test vectors deferred to v0.2)
- No CLI
- No fancy error types beyond `Error` with a `.code` string

---

## Function surface (14 verbs, one file)

### 1. Keys / identity

**The SDK does not generate keypairs.** Keygen runs in user-controlled hardware or a vetted external signer. The SDK only consumes keys the user already has. This is a security boundary, not a missing feature.

```js
// User provides a key via NIP-19 bech32 string (nsec or npub).
// SDK parses, validates, returns canonical form.
voyager.fromNsec('nsec1...')
  → { npub: 'npub1...', nsec: 'nsec1...' }
  // Throws VoyagerError('INVALID_KEY') on bad input.

// User can also import from a hardware signer (NIP-46 remote-signer protocol),
// a seed phrase (BIP-39 → BIP-32 → secp256k1), or any external source.
// Those integrations are NOT in the MVP. User wires their own.
```

**Why no keygen in the SDK:**
- Browser/Node CSPRNGs are fine; the SDK could generate valid keys.
- But the *security model* demands keys never touch JS memory where
  they can be exfiltrated by a compromised script, log line, or
  debugger. That's what hardware keys are for.
- Generating in the SDK and "hoping the user exports to hardware"
  is exactly the foot-gun this design avoids.
- Hardware flow: user generates on their device, exports the
  `nsec1...` (or uses a remote signer), pastes/scans it into the
  app. The SDK sees the bytes only at the moment of signing.

**Exception: a built-in demo key for SDK exploration.** For developers
loading the SDK for the first time, a `voyager.demoKey()` function
returns a hardcoded keypair that everyone shares. Clearly labeled,
clearly worthless, useful for the first hour of poking at the API.

```js
voyager.demoKey()
  → { npub: 'npub1demo...', nsec: 'nsec1demo...' }
  // Throws VoyagerError('DEMO_KEY_DISABLED') if NODE_ENV === 'production'
  //   or if window.location.hostname matches a production pattern.
  // Public key is published in this design doc and on the SDK homepage.
  // All SDK examples and the sandbox use this key.
  // NEVER use for real value. Never publish real events from it to mainnet
  //   without explicitly understanding the consequences.
```

**Why we ship this:**
- Removes the "where do I get a key" friction from the first 5 minutes.
- The key is shared by every developer, so signing with it is obviously
  not a real-user action — nobody mistakes it for their own identity.
- SDK examples, docs, the conformance sandbox, and the test vectors
  all reference the same key, so docs always match what the user sees.
- The publish-protection (refuses to run in prod) means an accidental
  `voyager.demoKey()` in a deployed app doesn't accidentally publish
  signed events from a shared identity to mainnet.

**The demo key (committed to the repo as plaintext):**

```json
// voyager-sdk/demo-key.json (publicly committed)
{
  "npub": "npub1voyager000000000000000000000000000000000000000000000000000demo",
  "nsec": "nsec1voyager000000000000000000000000000000000000000000000000000demo"
}
```

(TODO: generate the real bech32 values before ship. The placeholder
above is for the design doc only. The real keypair is generated once
on a clean machine using `node -e "..."` + a known CSPRNG, tested,
then committed to `voyager-sdk/demo-key.json` in the repo root.
Both `npub` and `nsec` are public — that's the point.)

The `demo-key.json` file is committed plaintext in the repo. Same
file is imported by tests, examples, and the README's "quick start"
section. The npm package ships this file as a public asset. Anyone
who clones the repo can read it. That's the security model: shared,
public, worthless for anything real.

Production apps MUST use `voyager.fromNsec(<their-own-nsec>)` instead.
`demoKey()` is a developer convenience, not a deployment primitive.
The prod-guard in `demoKey()` exists so an accidental deploy doesn't
fire events from this shared identity.

Not in MVP scope: a `voyager.keygen()` for non-custodial test
workflows. That's a v0.2 concern.

### 2. Event signing + verification

```js
voyager.sign(template, sk)
  → signed event  // kind, content, tags, created_at → adds pubkey, id, sig
  // template = { kind, content?, tags?, created_at? }

voyager.verify(event)
  → true | false
  // Throws VoyagerError('INVALID_EVENT') on malformed input

voyager.eventId(event)
  → hex sha256 of the canonical event serialization
```

### 3. Listings (kind 30402)

```js
voyager.listing(input, sk)
  → signed kind:30402 event
  // input = { d, title, price: [amount, unit], v?: [[ns, k, v], ...], content?, ... }
  // v tags are passed through as raw 4-string arrays (Open World)
  // Throws if d, title, or price missing

voyager.listings({ relays, author?, d?, kinds=[30402], timeout? })
  → [{ d, title, price, v, event, created_at }, ...]
  // Fans out across all relays, merges by event id, dedups. Sorted by created_at desc.
  // Returns when all relays have responded OR timeout fires — whichever first.
```

### 4. Stalls (kind 30017)

```js
voyager.stall(input, sk)
  → signed kind:30017 event
  // input = { d, name, currency?, shipping?, about?, image?, v? }

voyager.stalls({ relays, author?, timeout? })
  → [{ d, name, currency, shipping, about, event }, ...]
  // Same fan-out + dedup semantics as listings().
```

### 5. DM (NIP-17 — single call surface)

```js
voyager.dmSend(toNpub, payload, sk, { relays, ... })
  → { id }   // rumor → wrap → publish in one call

voyager.dmOpen(giftwrapEvent, recipientSk)
  → { fromNpub, rumor } | null
  // Decrypts + verifies inner signature. Returns null on sig failure.

voyager.dmInbox(recipientSk, { relays, since?, until?, limit? })
  → [{ fromNpub, rumor, giftwrap, openedAt }, ...]
  // Fans out across relays, opens each gift-wrap addressed to recipientSk's npub.
```

### 6. Ramp (kind 38383)

```js
voyager.rampIntent({ side, amt, fiat, method?, z? }, sk)
  → signed kind:38383 intent event
  // side = 'buy' | 'sell'
  // amt = [amount, 'sats']
  // fiat = [amount, 'CCY']
  // z tags pass through for ramp-specific metadata

voyager.rampQuote(intentEventOrId, { fee_sats, maker_pubkey, method, rate_sats_per_unit, reputation }, sk)
  → signed kind:38383 quote event
  // ref tag = intent's d-tag

voyager.rampQuotes({ intentId, relays, timeout? })
  → [quoteEvent, ...]
  // Same fan-out + dedup semantics.
```

### 7. Relay transport

```js
voyager.publish(relay | relays, event)
  → { ok: true, relay } | throws VoyagerError('RELAY_ERROR')
  // Tries each relay in order until one accepts. Returns first OK.

voyager.get(relay | relays, filter)
  → event | null
  // filter = NIP-01 filter object: { kinds, authors, d_tags, since, until, limit }

voyager.on(filter, callback)
  → unsub() function
  // Generic subscription. callback fires for each event as it arrives from any relay, in real-time.
  // Maintains one WebSocket per relay; dedups events by id across relays.
  // unsub() closes all sockets.
```

---

## Cross-cutting decisions

| Question | Answer |
|----------|--------|
| Default timeout per relay call | 10s, overridable per call |
| Error shape | Throw `VoyagerError` with `.code` string |
| `relays` parameter | Array accepted everywhere; **fan-out on reads** (query all, merge by event id, dedup), **first-OK on publish** (first relay that accepts wins) |
| DM API | **Single call.** `voyager.dmSend(...)` does rumor → wrap → publish in one. No split verbs exposed for MVP. |
| Subscriptions | Real-time streaming — callback fires as each event arrives from any relay, no batching, no waiting for "complete" result. |
| Global state / config | Yes — `voyager.config({ defaultRelays: [...], timeout: 10000 })` sets module-level defaults. Per-call `relays` arg overrides. |
| Validation | Minimal on write (required substrate fields only). None on read. |
| Crypto fallback | If secp256k1 hand-roll proves unworkable, add `@noble/curves` (MIT, audited) as the one allowed dep. |

```js
// Setup once at app entry
voyager.config({
  defaultRelays: ['wss://relay.damus.io', 'wss://nos.lol'],
  timeout: 10000,
});

// Then just call — config provides defaults
await voyager.publish(ev);
await voyager.listings({ author: vendorNpub });
```

Per-call override still works:

```js
await voyager.publish('wss://my-relay.example.com', ev);   // one-off
await voyager.listings({ relays: ['wss://other'], ... }); // overrides config
```

## What the SDK is, in one breath

A single ESM file you `import` into a SvelteKit component or a Node service. It produces, signs, publishes, fetches, and parses Voyager substrate events (kinds 30402, 30017, 14, 1059, 38383) without any runtime dependencies. Fans out reads across all configured relays (merge + dedup), publishes to the first relay that accepts, streams subscription events realtime as they arrive. ~500 lines of code. One file. No build step.

## Deferred decisions (open)

1. **secp256k1 source**: hand-rolled vs `@noble/curves` — defer until first sign/verify test runs.
2. **Test vectors baked in**: separate `voyager test` script, OR skip for MVP and let users test against real relays.
3. **Sub-namespaces on `v` tags**: pass-through only for MVP. No `voyager.listing.v1` parsing. Convention authors own the schema.
4. **Keygen**: RESOLVED. SDK does not generate keys. User brings their own (hardware signer, NIP-46 remote signer, or external key management). `fromNsec()` + `demoKey()` only. `demoKey()` refuses to run in production.

---

End of design. Next step (when you say go): write `voyager.js` per this spec, `package.json` per the layout above, ship to local `node_modules` and smoke-test with `node --test`.

---

## Demo runner (`demo.js`)

A single file that exercises every public verb end-to-end and prints
what's happening to the console. Runs in Node 22+ with no relay
network required — uses a local in-process mock relay for reads so
the demo is fully self-contained and reproducible.

```js
// voyager-sdk/demo.js
// Run:  node demo.js
//
// Walks through every feature in the SDK. No real relays, no real
// fiat, no real keys. Everything observable via console.log.
```

**What it demonstrates, in order:**

1. `voyager.demoKey()` — print the demo keypair
2. `voyager.fromNsec(nsec)` — round-trip parse
3. `voyager.sign(template, sk)` — build + sign a minimal event
4. `voyager.verify(event)` — confirm signature
5. `voyager.listing(input, sk)` — build a kind:30402 listing with
   `voyager.listing.v1` `v` tags
6. `voyager.stall(input, sk)` — build a kind:30017 stall
7. `voyager.publish(relay, event)` — publish to mock relay
8. `voyager.listings({ relays, d })` — fan-out + merge read
9. `voyager.publish(...)` — first-OK behavior on multiple relays
10. `voyager.on(filter, cb)` — subscribe, receive event in realtime
11. `voyager.dmSend(toNpub, payload, sk)` — rumor → wrap → publish
12. `voyager.dmOpen(giftwrap, recipientSk)` — decrypt + verify
13. `voyager.dmInbox(sk)` — fan-out inbox open
14. `voyager.rampIntent(input, sk)` — build a kind:38383 intent
15. `voyager.rampQuote(intent, quote, sk)` — build a quote
16. `voyager.rampQuotes({ intentId })` — aggregate quotes
17. `voyager.config({ defaultRelays })` — set + show config
18. Validation failure paths — bad nsec, missing required fields,
    invalid signature — print `VoyagerError` with `.code`

**Mock relay:** a single small class in the same file that
implements the subset of NIP-01 we need:

- `connect()` / `disconnect()`
- `publish(event)` — stores in memory by id, treats last-wins for
  replaceable kinds
- `subscribe(filter, onEvent)` — emits matching events, then any
  newly-published events that match
- `query(filter)` — returns matching events array

Fakes the wire but is byte-faithful: events go through the same
serialization the real SDK uses, so what the demo prints is exactly
what a real relay would see.

**Console output style:** plain text, one section per feature,
labeled with step number and a one-line description. Not pretty.
Not colorful. Runnable by anyone, pasteable into a bug report.

```
[ 1] demoKey()          → npub1voyager…demo
[ 2] fromNsec(nsec)     → npub1voyager…demo  (round-trip OK)
[ 3] sign(template, sk) → kind:1 id=abc123… sig=def456…
[ 4] verify(event)      → true
[ 5] listing(input, sk) → kind:30402 id=ghi789…
...
[17] config(...)        → { defaultRelays: [...], timeout: 10000 }
[18] error paths        → 4 thrown, 4 caught, all OK
```

**Why this matters:**
- New contributors run `node demo.js` and see the SDK work end-to-end
  in 30 seconds without needing a relay, a wallet, or a real key.
- CI runs `node demo.js` as a smoke test on every PR. If the demo
  breaks, the SDK is broken, full stop.
- The output doubles as documentation — when a user says "I tried X
  and got Y", they paste the relevant demo section.
