# Fix `RELAY_ERROR: all relays failed` in `node demo.js`

## Root cause (found in code)

`publish` at `voyager.js:807-820` has the signature `publish(relaysArg, event)`. `demo.js:75` calls `v.publish(listing)` with one argument — the event. The SDK then:

1. `resolveRelays(listing)` — `arg` is not undefined/null, so it falls through to `normalizeRelays(arg)` (`voyager.js:50-53` → `45-48`). The event object is truthy and not an array, so it gets wrapped: `relays = [listing]`. **The event object is now treated as a relay URL.**
2. Loop iteration: `relayUrl(r)` where `r` is the event object — `event.replace(/^http(s)?:/, "ws$1:")` throws **`TypeError: r.replace is not a function`** synchronously.
3. The TypeError is caught by the `try/catch` at `voyager.js:815`, stored in `lastErr`.
4. Loop ends, `throw new VoyagerError("RELAY_ERROR", "all relays failed", lastErr)` at line 819.
5. **`VoyagerError` (`voyager.js:20-26`) ignores its third argument**, so the TypeError is silently dropped. The user sees only `"all relays failed"`.

The README at `README.md:43` documents the same single-arg call shape (`await voyager.publish(listing);`), so this isn't a demo typo — the public API is mismatched with how the SDK calls itself internally (`voyager.js:584` does `await publish(resolveRelays(opts.relays), ev)` — relays-first).

**Two compounding bugs, both required to produce this exact error:**

- API order: `publish(relaysArg, event)` instead of `publish(event, relaysArg?)`. Single-arg call lands the event in the relay-slot.
- Error swallowing: `VoyagerError` doesn't keep `cause`, hiding the real `TypeError`.

Fixing only one would mask the other on the next failure.

## Plan

### 1. Reverse `publish()` arg order — `voyager.js:807-820`

New signature: `publish(event, relaysArg)`. Single-arg calls become the documented happy path.

```js
export async function publish(event, relaysArg) {
  if (!event || typeof event !== "object" || !event.id || !event.sig) {
    throw new VoyagerError("INVALID_EVENT", "publish requires a signed event");
  }
  const relays = resolveRelays(relaysArg);
  if (relays.length === 0) throw new VoyagerError("RELAY_ERROR", "no relays configured");
  const errors = [];
  for (const r of relays) {
    try {
      return await pubOnce(relayUrl(r), event, CONFIG.timeout);
    } catch (e) {
      errors.push({ relay: r, error: e });
    }
  }
  const summary = errors.map(({ relay, error }) =>
    `${relay}: ${error?.code ?? "?"} ${error?.message ?? String(error)}`
  ).join(" | ");
  throw new VoyagerError("RELAY_ERROR", `all relays failed — ${summary}`, errors);
}
```

### 2. Update the one internal call site — `voyager.js:584`

```js
await publish(ev, opts.relays);
```

(direct internal call — `resolveRelays` no longer needed since `publish` now does that itself.)

### 3. Preserve `cause` on `VoyagerError` — `voyager.js:20-26`

```js
export class VoyagerError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "VoyagerError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}
```

Defence-in-depth — even after the API fix, `lastErr`-style attachments will surface on every other failure path that already passes a third arg.

### 4. Drop demo timeout + add diagnostic print — `demo.js:9, 75`

- `timeout: 10000` → `timeout: 4000` so failures are fast.
- Wrap `publish` in try/catch that prints `err.message`, `err.cause`, and a `relayHealth()` snapshot, then rethrows.

### 5. Document the API + Node >= 22 requirement — `README.md`

Single line under the Quick Start: `voyager.publish(event, relays?)`.

## Files touched

- `voyager.js` — `publish()` rewrite (~15 lines), `dmSend` call-site at line 584 (1 line), `VoyagerError` constructor (1 hunk).
- `demo.js` — `timeout` value + try/catch wrapper around `publish` (~10 lines).
- `README.md` — 1-line signature note.

No new deps. No new files. One breaking-change in the SDK (the only place the old `(relays, event)` order was used internally is line 584, which we update). External callers using the documented single-arg form keep working — and now actually work.

## Validation

1. `node --check voyager.js && node --check demo.js` — syntax.
2. `node demo.js` — `publish(listing)` should now succeed (reach the relays and return `{ok:true, relay:"wss://..."}` for the first one that accepts). At minimum it should not throw the masked `TypeError`.
3. Negative test: temporarily set `defaultRelays: ["wss://127.0.0.1:1"]` and confirm the thrown error has `code: 'RELAY_ERROR'`, message includes the relay URL, and `cause` is the per-relay array.
4. `v.publish({})` (no id/sig) should throw `INVALID_EVENT` cleanly.

## Out of scope

- Adding NIP-42 auth, retries, or relay pinning.
- Changing default relay list.
- Browser-side changes (global `WebSocket` already used everywhere).
