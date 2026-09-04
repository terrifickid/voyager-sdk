# Voyager — Protocol RFC

```
Series:      voyager
Type:        Standard Track
Status:      DRAFT (target: PROPOSED after alpha build)
Version:     0.4.0
Replaces:    VOYAGER_PROTOCOL.md (v3) and EXTENSIBILITY_TAGS_THESIS.md (v3.1)
            (those documents are preserved as historical; this RFC is canonical
            going forward)
Created:     2026-09-04
Layer:       application protocol (runs over Nostr + Lightning + Mostro)
Audience:    implementers, auditors, operators
```

This document defines Voyager as a formal protocol. It is modeled on the shape
of NIPs (Nostr) and BOLTs (Lightning): section numbers are stable, normative
language uses RFC 2119 keywords, and any implementation claiming
conformance MUST pass the test vectors in §17.

Voyager is to commerce what ActivityPub is to social, what SMTP is to mail,
what BOLT-11 is to Lightning, what NIP-17 is to private messaging: a small,
stable substrate that lets independent operators ship interoperable software
without coordinating with each other on every change.

---

## Table of Contents

  0.  Design invariants
  1.  Architecture and layer model
  2.  Roles and threat model
  3.  Naming and terminology
  4.  Conformance and versioning
  5.  Transport: Nostr events
  6.  Transport: Lightning
  7.  Substrate event kinds (30402, 30017, 1059, 14, 38383)
  8.  Substrate tag grammar
  9.  Conventions: the `v` tag namespace
 10.  Listing schema (kind:30402)
 11.  Stall schema (kind:30017)
 12.  Order flow state machine (kinds 14 / 1059)
 13.  Fiat ramp protocol (kind:38383 + Mostro)
 14.  SDK contract (the API surface implementations MUST expose)
 15.  Reference clients and operator toolkit
 16.  Naming, distribution, and identity binding
 17.  Conformance test vectors
 18.  Threat model and EROI mapping
 19.  What this RFC explicitly does NOT solve
 20.  Change-log

Appendix A.  JSON-Schema for substrate event kinds
Appendix B.  Worked examples: physical listing, tour, accommodation, ramp quote
Appendix C.  Migration notes from v3 protocol + v3.1 thesis

---

## 0. Design invariants

These five invariants are non-negotiable. Every normative statement in this
RFC preserves all five; any proposed change that violates one is out of scope
and MUST be rejected on those grounds alone.

I-1  **No custody anywhere in the protocol layer.** No actor in the protocol,
     including any reference implementation, holds a user's funds at any time
     or for any duration longer than a Lightning HTLC's cryptographic lifetime.

I-2  **No identity beyond a keypair is required.** A user is a Nostr keypair.
     Nothing more. Email, phone, password, "account", or any other identifier
     is OPTIONAL and entirely outside the protocol.

I-3  **Customer-side and vendor-side are symmetric.** The same key discipline,
     the same trust model, the same UX class. There is no special "merchant"
     class.

I-4  **The protocol runs even if Voyager-the-business vanishes.** Every
     normative behavior in this RFC is achievable by independent operators
     using independent infrastructure. Voyager-the-business runs reference
     implementations; it does not run the protocol.

I-5  **Payments are Lightning.** On-chain Bitcoin transactions are out of
     scope for routine commerce in this RFC. Hodl invoices are the canonical
     escrow primitive for the fiat ramp.

---

## 1. Architecture and layer model

Voyager is a four-layer system. Implementations MUST treat layers below them
as black boxes; layers above treat Voyager as a black box.

```
+--------------------------------------------------------------+
|  APPLICATION LAYER                                           |
|   - reference clients (voyager-web, vendor-seller-app)       |
|   - third-party apps built on @voyager/sdk                   |
|   - MCP server (voyager-mcp; AI agents consume protocol)     |
+--------------------------------------------------------------+
                          |
                          v
+--------------------------------------------------------------+
|  SDK LAYER  (@voyager/sdk)                                   |
|   - identity, event signing, gift-wrap, NWC, ramp quotes,    |
|     listing search, DM send/receive                          |
|   - lean, deterministic, crypto-native, NO AI inside         |
+--------------------------------------------------------------+
                          |
                          v
+--------------------------------------------------------------+
|  PROTOCOL LAYER  (this RFC)                                  |
|   - event kinds 30402, 30017, 14, 1059, 38383                |
|   - tag grammar, v-tag conventions, state machines           |
+--------------------------------------------------------------+
                          |
                          v
+--------------------------------------------------------------+
|  TRANSPORT LAYER                                             |
|   - Nostr relays (NIP-01) for event forwarding               |
|   - Lightning Network (BOLT-11, BOLT-04 hodl) for value      |
|   - Mostro nodes for fiat<->sats arbitration                 |
+--------------------------------------------------------------+
```

### 1.1 Layer rules

- L4 (transport) is defined by existing specifications (NIP-01, NIP-17,
  NIP-44, NIP-47, BOLT-11, BOLT-04, and the Mostro protocol). This RFC
  REFERENCES those specs but does not redefine them.
- L3 (protocol) is what this RFC defines.
- L2 (SDK) is what §14 defines as the contract.
- L1 (application) is not specified; reference clients are listed in §15.

### 1.2 The AI/MCP boundary (informative)

The MCP server and any AI/ML consumer (WebLLM, hosted LLM, agent
framework) lives in L1 (application). The SDK (§14) MUST NOT depend on,
embed, or assume the presence of any AI runtime. AI consumers call the SDK
through the same surface as human-driven clients. This keeps the SDK
small, auditable, and embeddable in environments where loading a
multi-GB WASM model is unacceptable.

```
WebLLM (in-browser or local)            <-- L1, OPTIONAL
    |
    v calls MCP
voyager-mcp server                      <-- L1, OPTIONAL
    |
    v uses
@voyager/sdk                            <-- L2, REQUIRED for conformance
    |
    v uses
nostr relays + lightning + mostro       <-- L4
```

---

## 2. Roles and threat model

### 2.1 Roles

| Role | Defined as | Custodian of |
|------|------------|--------------|
| User | Holder of a Nostr keypair | Their own private key |
| Customer | A user buying a listing | Nothing protocol-relevant |
| Vendor | A user publishing listings | Their listings; their NWC budget |
| Relay operator | Anyone running a NIP-01 relay | Cached public events, briefly cached gift-wraps |
| Mostro node operator | Anyone running a Mostro daemon | Hodl-invoice arbiter with reputation at stake; never fiat |
| Indexer operator | Anyone running voyager-idx or compatible | Derived cache; fully discardable |
| MCP server operator | Anyone running voyager-mcp | Nothing; stateless |
| Voyager-the-business | A particular operator that publishes this RFC and reference code | Nothing protocol-critical |

A single legal person MAY hold multiple roles. The protocol does not
prevent this; clients SHOULD display provenance so users can make
informed choices.

### 2.2 Adversary classes

This RFC's threat model (§18) explicitly considers:

- A-1  Single relay operator (malicious or compromised)
- A-2  Majority of relay operators in a client's bootstrap set
- A-3  A single Mostro node operator
- A-4  A regional network adversary (ISP-level blocking)
- A-5  A single jurisdiction (subpoena, seizure, regulation)
- A-6  An acquirer of Voyager-the-business
- A-7  An attacker who compromises a user's keypair
- A-8  An attacker who compromises a vendor's keypair

The protocol is not designed to defend against A-2, A-7, or A-8 at the
protocol layer — those are out of scope by invariant I-1 and I-2.

---

## 3. Naming and terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 (RFC 2119, RFC 8174) when, and only when, they appear in all
capitals, as shown here.

- **Addressable event**: a Nostr event whose canonical identity is the
  tuple `(kind, pubkey, d-tag)`. Two events with the same tuple at
  later timestamps supersede earlier ones. See NIP-01 and NIP-33.
- **Convention**: a document, identified by a `v`-namespaced tag, that
  defines the semantics of a set of fields. See §9.
- **Hodl invoice**: a BOLT-11 invoice whose preimage is held but not
  released by the invoicing node until an out-of-band settlement
  decision. See BOLT-04.
- **Indexer**: a service that subscribes to relays and exposes
  derived query APIs over the events it has seen.
- **Listing**: a kind:30402 event.
- **NWC**: Nostr Wallet Connect, NIP-47.
- **Rumor**: an unsigned inner event inside a NIP-17 gift-wrap.
- **Substrate**: the parts of the protocol this RFC defines.
- **Stall**: a kind:30017 event.
- **User**: any holder of a Nostr keypair; cf. Customer/Vendor.

---

## 4. Conformance and versioning

### 4.1 Conformance levels

An implementation MAY claim conformance at one of the following levels:

- **L1 — Producer**: emits substrate events that validate against
  Appendix A and pass §17 test vectors.
- **L2 — Consumer**: subscribes, parses, and renders substrate events
  including at least one convention per §9.
- **L3 — NWC**: L2 + implements NIP-47 client and/or server.
- **L4 — Ramp**: L3 + implements the kind:38383 ramp intent / quote /
  Mostro trade flow (§13).
- **L5 — Reference Client**: ships a user-facing app that meets the UX
  baseline in §15.

The reference SDK MUST be L4-conformant. Reference clients SHOULD be
L5-conformant. Implementers MUST publish a conformance statement
identifying which levels they meet and which conventions they recognize.

### 4.2 Protocol version

This document is `voyager-0.4.0`. Backward-incompatible changes to the
substrate (event kinds, tag grammar, required fields) require a new
major version. Backward-compatible additions (new optional tags, new
conventions, new event kinds ≥ 30000) MAY ship in minor versions.

Conventions under §9 version independently as `voyager.<name>.v<n>`.
See §9.5.

---

## 5. Transport: Nostr events

### 5.1 Event signing

All Voyager events MUST be signed per NIP-01 using the same keypair
that the user uses for normal Nostr activity. There is no "Voyager key".

### 5.2 Relay selection

Clients SHOULD maintain a list of ≥ 3 NIP-01 relays and SHOULD fan
subscriptions across them. The default bootstrap set is RECOMMENDED
to be:

```
relay.damus.io
nos.lol
relay.nostr.band
nostr.wine
```

Adding more relays is RECOMMENDED. Removing relays is OPTIONAL but
SHOULD be done with care (single- or double-point-of-failure).

### 5.3 Event persistence requirements

Relays are not required to store any Voyager event type. Clients MUST
treat any read as a cache and SHOULD publish to multiple relays to
improve availability. Indexers (L4-role operators) MAY provide
persistent storage; clients MUST NOT assume indexer data is canonical.

### 5.4 Forwarding integrity

Relays MUST forward Voyager events even if they do not recognize the
kind or any tag. This is consistent with NIP-01 ("relays SHOULD forward
events with unknown kinds") and is required by §9 (conventions may be
unrecognized by older clients).

---

## 6. Transport: Lightning

### 6.1 Invoices

Routine commerce in Voyager uses BOLT-11 invoices. There is no
"Voyager invoice format" — Voyager reuses the Lightning invoice format.

### 6.2 NWC

Front-ends MUST use NIP-47 to talk to user wallets. The NWC URI is
paste-once, revocable, budget-scoped, and per-app. Front-ends MUST
NOT request or hold the user's seed or spend authority.

### 6.3 Hodl invoices (ramp only)

The fiat ramp (§13) uses BOLT-04 hodl invoices as the escrow substrate.
The Mostro node operator generates the invoice; sats are LOCKED but
not SETTLED until the operator releases the preimage (after fiat is
confirmed) or refunds (after dispute resolution or expiry). The
operator CANNOT redirect the sats; it can only release or refund.

### 6.4 Routing and liquidity

Out of scope for this RFC. Implementers SHOULD use established
Lightning routing practice; carriers of last resort MAY operate
lightning routing nodes as a commercial service but MUST NOT be
required by the protocol.

---

## 7. Substrate event kinds

This section defines the substrate. Conventions (§9) attach to these
kinds without modifying them.

### 7.1 Registry

| Kind  | Type                       | Purpose                                  | Encryption         |
|-------|----------------------------|------------------------------------------|--------------------|
| 30402 | addressable, replaceable   | Listing (product / service / experience) | public             |
| 30017 | addressable, replaceable   | Stall (storefront / vendor profile)      | public             |
| 1059  | gift-wrap (NIP-17)         | Sealed DM transport                      | NIP-44 + wrap      |
| 14    | inner rumor inside kind:1059 | Order request / response / receipt      | inner-signed       |
| 38383 | addressable, replaceable   | Ramp intent / Mostro quote               | public quote, optional wrap for flow |
| 30078 | addressable, replaceable   | Vendor-side settings / NWC hints         | public             |

The substrate MAY be extended with new kinds by publishing a new
section in a minor version of this RFC. Adding new kinds MUST NOT
require changes to existing clients (§9.4 Open World Assumption).

### 7.2 Common rules

- All replaceable events MUST carry a `d` tag.
- All DM-bearing events MUST be wrapped per NIP-17.
- All public events MUST be addressable where the event represents
  something with a stable identity (listing, stall, vendor, profile,
  quote).

---

## 8. Substrate tag grammar

Voyager uses standard NIP-01 tag semantics for `p`, `e`, `d`, `t`,
and the Nostr tag alphabet. Two non-standard prefixes are reserved:

- `v`  — Voyager convention tag. See §9.
- `r`  — Voyager reference (event id). For pointing at another event.

Implementations MUST preserve tags they do not understand (§9.4).

### 8.1 Standard tags used by Voyager

| Tag     | Where used       | Semantics |
|---------|------------------|-----------|
| `d`     | 30402, 30017, 38383, 30078 | Stable per-vendor id; addressability |
| `title` | 30402            | REQUIRED; human-readable listing title |
| `price` | 30402            | REQUIRED; integer + currency (default `sats`) formatted as `[amount, unit]` |
| `p`     | 14, 1059         | Recipient pubkey |
| `e`     | 14               | Event being replied to (e.g., the listing or the order rumor) |
| `t`     | 30402, 30017     | Free-form topic tags; clients SHOULD NOT depend on them |
| `r`     | 1059             | Voyager reference to another event id |
| `image` | 30402            | URL or `ipfs://` CID for an image |
| `status` | 30078          | Vendor state hint (`active`, `vacation`, etc.); clients SHOULD treat as informational only |

---

## 9. Conventions: the `v` tag namespace

### 9.1 Motivation

The protocol guarantees event **structure** and **forwarding integrity**.
The protocol does not guarantee event **semantics**. Adding a new
vendor kind (accommodation, tours, rentals, consulting, anything not
yet imagined) is done by publishing a **convention document**, not by
amending the substrate.

### 9.2 Form

A convention tag has four parts:

```
["v", "<namespace>", "<key>", "<value>"]
```

Where:

- `namespace` = `voyager.<type>.v<n>` (e.g., `voyager.listing.v1`,
  `voyager.accommodation.v1`, `voyager.tour.v1`)
- `key` = a field name defined by that convention
- `value` = a string value

A single event MAY carry `v` tags from multiple namespaces. Clients
render the namespaces they recognize and ignore the rest.

### 9.3 Resolution rule

A client that recognizes a namespace renders those tags. A client
that does not recognize a namespace ignores those tags. No client
MAY crash on, reject, or refuse to forward an event because of an
unrecognized `v` tag namespace.

### 9.4 Open World Assumption

The following MUST hold for every conformant implementation:

- Clients MUST preserve tags they do not render.
- Clients MUST NOT reject events for having unknown tags.
- Relays MUST forward events with unknown kinds or tags.
- Validators MUST NOT reject events for having unknown optional tags.
- Validators MUST reject events ONLY for malformed required substrate
  fields (Appendix A).

Closed-world validation is forbidden at the protocol level.

### 9.5 Convention versioning

Each convention is `<name>.v<n>`. New versions are new namespaces:

- `voyager.tour.v1` — original
- `voyager.tour.v2` — breaks compatibility, ships side-by-side

Old clients keep rendering v1. New clients render v2 if present, fall
back to v1 otherwise. Both versions coexist on the same network. No
migration event, no flag day, no relay coordination.

### 9.6 Initial conventions

This RFC defines three initial conventions:

- `voyager.listing.v1` — physical goods
- `voyager.accommodation.v1` — lodging
- `voyager.tour.v1` — experiences

Their definitions are in §10.3, Appendix B.1, and Appendix B.2
respectively. Future conventions are added by publishing a new
document under `voyager/<convention-name>.md` in the spec repository
and bumping the minor version of this RFC.

A registry of conventions lives at
`voyager.network/conventions/<namespace>.md` (canonical) and is mirrored
at IPFS (content-addressed). A namespace is considered REGISTERED when
the document is published there. Implementations MAY recognize
unregistered namespaces but SHOULD log a warning.

### 9.7 Comparison to other extensible systems

- Bitcoin soft forks: similar effect (backward-compatible changes via
  reserved opcode gaps). Voyager's `v` tag is the analog of a
  reserved opcode gap at the application layer.
- Nostr NIPs: similar effect (relays forward unknown kinds). Voyager's
  `v` tag is the analog at the tag level.
- JSON-LD `@context`: similar effect (sub-namespaced terms silently
  ignored if unmapped).
- RDF / Schema.org: similar effect (predicates are URIs; unknown
  predicates are preserved).

This is not novel. It is the well-trodden path for open-world
extensible systems.

---

## 10. Listing schema (kind:30402)

### 10.1 Required substrate fields

| Field        | Type   | Notes                              |
|--------------|--------|------------------------------------|
| `kind`       | 30402  | fixed                              |
| `pubkey`     | string | vendor npub                        |
| `created_at` | int    | unix seconds                       |
| `tags`       | array  | MUST include `d`, `title`, `price` |

The `content` field is OPTIONAL free-form description; it is intended
for human readers, not for parsing.

### 10.2 Tag layout

| Tag     | Required | Format                              |
|---------|----------|-------------------------------------|
| `d`     | MUST     | stable uuid                         |
| `title` | MUST     | human-readable string               |
| `price` | MUST     | `[amount, unit]`; unit defaults to `sats` |
| `image` | OPTIONAL | URL or `ipfs://` CID                |
| `t`     | OPTIONAL | topic tags                          |
| `v`     | OPTIONAL | zero or more convention tags        |

### 10.3 `voyager.listing.v1` convention fields

| Key               | Format                              | Notes |
|-------------------|-------------------------------------|-------|
| `duration_minutes` | integer                            | prep/fulfilment time |
| `shipping_zone`   | string or json array of zones       | e.g., `caribbean` |
| `delivery_method` | `pickup` \| `courier` \| `digital`  | comma-separated for multi |
| `price_alt_<CCY>` | `[amount, ccy]`                    | informational; e.g., `["25","USD"]` |
| `stock`           | integer                            | OPTIONAL; clients SHOULD treat 0 as "unavailable" |
| `perishable`      | `true` \| `false`                  | hint for delivery urgency |

Full JSON example in Appendix B.1.

---

## 11. Stall schema (kind:30017)

### 11.1 Required substrate fields

| Field        | Type   | Notes                              |
|--------------|--------|------------------------------------|
| `kind`       | 30017  | fixed                              |
| `pubkey`     | string | vendor npub                        |
| `created_at` | int    | unix seconds                       |
| `tags`       | array  | MUST include `d`, `name`           |

### 11.2 Tag layout

| Tag       | Required | Format                                |
|-----------|----------|---------------------------------------|
| `d`       | MUST     | stable uuid                           |
| `name`    | MUST     | stall display name                    |
| `currency`| OPTIONAL | default `sats`                        |
| `shipping`| OPTIONAL | JSON-stringified `[{zone, cost_sats}]` array |
| `about`   | OPTIONAL | human-readable stall description      |
| `image`   | OPTIONAL | banner URL or `ipfs://` CID           |
| `v`       | OPTIONAL | zero or more convention tags          |

### 11.3 Semantics

A stall is the vendor's storefront. Listings reference the vendor's
stall implicitly via `pubkey`. Clients SHOULD display stall metadata
when rendering any listing whose `pubkey` matches the stall's
`pubkey`.

---

## 12. Order flow state machine (kinds 14 inside 1059)

### 12.1 State diagram

```
                  +-----------------+
                  |  request_draft  |  (customer composing)
                  +--------+--------+
                           | send via NIP-17 gift-wrap (1059)
                           v
                  +-----------------+
                  |  request_sent   |
                  +--------+--------+
                           | vendor receives
                           v
                  +-----------------+
         +-------->|  vendor_review  |--------+
         |         +--------+--------+        |
         |                  | accept          | cancel (reason)
         |                  v                 v
         |         +--------+--------+   +--------+--------+
         |         |  invoice_open   |   |  request_cancelled |
         |         +--------+--------+   +-------------------+
         |                  | customer pays invoice
         |                  v
         |         +--------+--------+
         |         |  payment_held   |   (HTLC settled)
         |         +--------+--------+
         |                  | vendor fulfils
         |                  v
         |         +--------+--------+
         |         |  fulfilled      |--------+
         |         +--------+--------+        |
         |                  | customer receipts; or 30d timeout
         |                  v                       v
         |         +----------------+   +-------------------+
         +---------|  completed     |   |  completed_timeout |
            dispute+----------------+   +--------------------+
                  |
                  v
         +----------------+
         |  disputed      |  (out-of-band; protocol does not arbitrate)
         +----------------+
```

### 12.2 Rumor (kind:14) schemas

`order_request` (customer → vendor):

```json
{
  "kind": 14,
  "pubkey": "<customer npub>",
  "content": "{\"type\":\"order_request\",\"items\":[{\"d\":\"<listing-d>\"}],\"qty\":2,\"delivery\":{\"name\":\"...\",\"addr\":\"...\",\"phone\":\"...\",\"notes\":\"...\"}}",
  "tags": [["p","<vendor-pubkey>"],["e","<listing-event-id>"]]
}
```

`order_accept` (vendor → customer):

```json
{
  "kind": 14,
  "pubkey": "<vendor npub>",
  "content": "{\"type\":\"order_accept\",\"order_id\":\"sha256(<rumor-id>)\",\"invoice\":\"lnbc1...\",\"expires\":900,\"terms\":{\"shipping_days\":3,\"tracking\":\"optional\"},\"escrow\":\"none\"}",
  "tags": [["p","<customer-pubkey>"],["e","<rumor-id>"]]
}
```

`payment_receipt` (customer → vendor; OPTIONAL but RECOMMENDED):

```json
{
  "kind": 14,
  "pubkey": "<customer npub>",
  "content": "{\"type\":\"payment_receipt\",\"order_id\":\"...\",\"preimage_hash\":\"...\",\"paid_at\":1760000000}",
  "tags": [["p","<vendor-pubkey>"],["e","<rumor-id>"]]
}
```

`fulfilled` (vendor → customer):

```json
{
  "kind": 14,
  "pubkey": "<vendor npub>",
  "content": "{\"type\":\"fulfilled\",\"order_id\":\"...\",\"tracking\":\"...\",\"digital_payload_url\":\"...\"}",
  "tags": [["p","<customer-pubkey>"],["e","<rumor-id>"]]
}
```

### 12.3 Wrapping

Every kind:14 above MUST be wrapped in a kind:1059 gift-wrap per NIP-17
before publication. Relays MUST NOT be able to determine the
relationship between an order's request, accept, payment, and
fulfilment messages (sender, recipient, contents).

### 12.4 Order id

`order_id` = `sha256(<request_rumor_event_id>)`. This id is stable
across the entire state machine; all messages in a single order's
flow SHOULD reference the same `order_id`.

### 12.5 Expiry

An `invoice_open` state MUST transition out within the invoice's
`expires` window (default 900s). If payment does not arrive, the
vendor SHOULD publish a `request_cancelled` rumor.

### 12.6 Disputes

The protocol does not arbitrate disputes. The protocol's contribution
to dispute is the existence of the `disputed` terminal state and the
audit trail of NIP-17 gift-wraps retained by both parties. Vendor and
customer MAY invoke external mechanisms (Mostro arbiter, community
reputation, public zap trails).

---

## 13. Fiat ramp protocol (kind:38383 + Mostro)

### 13.1 Goals

- Allow customers to acquire or dispose of sats without using a
  centralized exchange.
- Allow Mostro node operators to compete on rate, fee, and fiat
  rail coverage.
- Keep the customer-side experience KYC-free.
- Allow the protocol to keep invariant I-1 (no custody).

### 13.2 Use of Mostro

Mostro is the chosen fiat ramp substrate. This RFC does not redefine
Mostro; it REUSES Mostro's existing event shapes:

- kind:38383 for intent and quote events (Mostro already uses this)
- kind:1059 for the encrypted trade flow
- BOLT-04 hodl invoices for escrow

The Voyager layer adds:

- A `z` tag convention namespace (`voyager.ramp.v1`) for ramp-specific
  metadata.
- A bridge pattern in §13.5 for clients to aggregate quotes from
  multiple Mostro nodes.

### 13.3 Ramp intent (kind:38383, customer)

Buyer:

```json
{
  "kind": 38383,
  "pubkey": "<customer npub>",
  "tags": [
    ["d", "<unique-intent-id>"],
    ["s", "buy"],
    ["amt", "50000", "sats"],
    ["f", "JMD", "2500"],
    ["z", "voyager.ramp.v1", "method", "wise|remitly|cash-deposit"],
    ["z", "voyager.ramp.v1", "expires", "1800"]
  ]
}
```

Seller: same shape with `s=sell`.

### 13.4 Quote (kind:38383, Mostro node)

```json
{
  "kind": 38383,
  "pubkey": "<mostro-node-pubkey>",
  "tags": [
    ["d", "<quote-id>"],
    ["ref", "<intent-id>"],
    ["z", "voyager.ramp.v1", "fee_sats", "500"],
    ["z", "voyager.ramp.v1", "maker_pubkey", "<peer-seller npub>"],
    ["z", "voyager.ramp.v1", "method", "wise"],
    ["z", "voyager.ramp.v1", "rate_sats_per_unit", "20.0"],
    ["z", "voyager.ramp.v1", "reputation", "0.92"]
  ]
}
```

### 13.5 Bridge pattern (clients)

A client (the "bridge") SHOULD:

1. Subscribe to all reachable relays for kind:38383 events.
2. Cache `(rate, fee, method, reputation, expiry)` per quote.
3. Present top-N quotes to the user, ranked by
   `(effective_rate, fee, node_reputation, method_match, freshness)`.
4. When the user selects a quote, open a kind:1059 (NIP-17) encrypted
   channel directly to the Mostro node's pubkey to begin the trade.

The bridge does NOT custody fiat and does NOT arbitrate. It only
aggregates and routes.

### 13.6 Trade state machine (delegated to Mostro)

Voyager inherits Mostro's existing state machine. The Voyager layer
adds a thin envelope:

```
pending  →  locked  →  settled   (success)
                  ↘  released  (refund)
                  ↘  disputed  (out-of-band arbitration)
```

Nodes MUST NOT redirect sats. Hodl-invoice contracts enforce this.

### 13.7 Operator economics

Mostro node operators set their own:

- fees (per trade or bps)
- supported fiat currencies
- supported fiat rails
- arbitration SLA
- jurisdiction preferences

Voyager does not standardize these. Voyager operates one reference
node (voyager-mostro) tuned for Caribbean rails; its published policy
is informational and not part of this RFC.

---

## 14. SDK contract

This section is normative. Any package claiming to be a Voyager-
conformant SDK MUST expose the surface below. The surface is described
in TypeScript-flavoured pseudocode; implementations in other
languages SHOULD provide idiomatic equivalents with semantically
identical behavior.

### 14.1 Identity

```
voyager.identity.create(): { npub, nsec }      // generate
voyager.identity.import(nsec): { npub }
voyager.identity.export(): { nsec }            // explicit user gesture
voyager.identity.sign(eventTemplate): signedEvent
```

The SDK MUST NOT persist `nsec` to disk without explicit user opt-in.
It MUST allow export and re-import. It MUST NOT log `nsec`.

### 14.2 Payment (NWC)

```
voyager.pay.invoice(bolt11: string, opts?): Promise<{ preimage }>
voyager.pay.quote(bolt11): Promise<{ fee_sats, hop_hints }>
voyager.nwc.connect(uri: string): void        // paste NWC URI
voyager.nwc.disconnect(): void
voyager.nwc.budget(): Promise<BudgetState>    // current budget
```

The SDK MUST communicate with the user's wallet via NIP-47 only. It
MUST NOT request, store, or transmit the user's seed or spend
authority beyond the NWC scope.

### 14.3 Listing

```
voyager.listing.create(input: ListingInput): Promise<EventId>
voyager.listing.update(d: string, patch: Partial<ListingInput>): Promise<EventId>
voyager.listing.get(pubkey: string, d: string): Promise<Listing | null>
voyager.listing.search(query: ListingQuery): AsyncIterable<Listing>
voyager.listing.delete(d: string): Promise<void>   // soft-delete via empty event
```

`ListingInput` MUST be expressed as `(substrate fields, v tags)`. The
SDK MUST NOT bake any single convention into the listing type; new
conventions are surfaced as opaque `Record<string, string[]>` arrays
that clients pass through.

### 14.4 Stall

```
voyager.stall.create(input: StallInput): Promise<EventId>
voyager.stall.update(d: string, patch: Partial<StallInput>): Promise<EventId>
voyager.stall.get(pubkey: string): Promise<Stall | null>
```

### 14.5 Messaging (NIP-17)

```
voyager.dm.send(toNpub: string, payload: any): Promise<RumorId>
voyager.dm.subscribe(): AsyncIterable<DecryptedRumor>
voyager.dm.parse(rumor): OrderMessage | null   // type-discriminated
```

`OrderMessage` MUST accept `order_request`, `order_accept`,
`payment_receipt`, `fulfilled`, and `request_cancelled`. Unknown types
MUST be returned as `UnknownMessage` with the raw `kind:14` content.

### 14.6 Ramp

```
voyager.ramp.intent(input: RampIntent): Promise<IntentId>
voyager.ramp.quotes(intentId: string): AsyncIterable<Quote>
voyager.ramp.start(intentId, quoteId): Promise<TradeId>  // opens NIP-17 channel
voyager.ramp.trades(): AsyncIterable<TradeEvent>
```

### 14.7 MCP consumer convenience (OPTIONAL surface)

A separate package `@voyager/mcp` MAY wrap the SDK into MCP tools. The
core SDK MUST NOT depend on MCP.

### 14.8 Non-negotiables for the SDK

- Zero AI/ML dependencies in the core SDK.
- Zero telemetry to Voyager-the-business by default.
- Total install size (excluding peer deps) MUST be < 200 KB minified
  + gzipped for the TypeScript reference implementation.
- The SDK MUST be MIT or Apache 2.0 licensed.
- The SDK MUST publish source maps.
- The SDK MUST be deterministic — given the same inputs, the same
  signed events.

---

## 15. Reference clients and operator toolkit

### 15.1 Reference clients

| Name                | Role                          | Conformance |
|---------------------|-------------------------------|-------------|
| voyager-web         | Customer marketplace          | L5          |
| vendor-seller-app   | Vendor dashboard              | L5          |
| voyager-mcp         | AI-agent lens (MCP server)    | L5          |
| voyager-idx         | Indexer (optional cache)      | L4          |
| voyager-relay       | Bootstrap Nostr relay         | transport-only |
| voyager-mostro      | Reference Mostro node         | ramp-only   |

These are reference implementations, not products. Vendors and
operators SHOULD build their own; the reference implementations
exist to demonstrate the protocol and to set the UX baseline.

### 15.2 Operator toolkit

The operator toolkit (`voyager-operator-toolkit`) MUST be a
declarative Docker Compose / Helm deployment that brings up:

- 1+ Nostr relays (NIP-01)
- 1+ Mostro node
- 1+ indexer
- A landing page documenting the operator's services and policies

The toolkit MUST NOT depend on Voyager-the-business for any of these
to function.

### 15.3 Conformance sandbox

The conformance sandbox (`voyager-sandbox`) MUST provide:

- A local dev environment with mock relays, regtest Lightning nodes,
  and simulated Mostro peers.
- Test vectors for every substrate event kind in Appendix A.
- A CLI command `voyager-sandbox up` / `voyager-sandbox down`.
- No mainnet connectivity by default.

The sandbox MUST be usable by a third-party implementer to validate
their client without ever touching mainnet or real fiat.

---

## 16. Naming, distribution, and identity binding

This section is normative for Voyager-the-business and RECOMMENDED
for any operator publishing reference software.

### 16.1 Canonical name

The canonical protocol name is `voyager`. The canonical organization
identifier for reference artifacts is `voyager.network` (DNS) backed
by ENS (`voyager.eth`) backed by IPFS content addressing. None of
these three is load-bearing; any one can fail without losing the
protocol's accessibility.

### 16.2 Bundle identity

A released bundle of any reference client MUST embed, at build time:

- `EXPECTED_CID` — the IPFS CID of the released bundle
- `HOLDCO_ETH` — the Ethereum address that owns `voyager.eth`
- `HOLDCO_NSEC` — the Nostr pubkey that announces releases

The client MUST verify these against a manifest fetched from at least
two independent sources (e.g., GitHub raw + IPFS gateway + ENS
contenthash) on every boot, and MUST refuse to operate if any source
disagrees.

### 16.3 Resolution

Clients SHOULD resolve `voyager.eth` via at least two independent
ENS resolvers (e.g., eth.limo + eth.link + a user's own RPC) and MUST
halt with a clear error if resolvers disagree about the contenthash.

### 16.4 Local-install path

Reference clients MUST be installable from source on `localhost` or
`ipfs://` with no DNS dependency. The on-disk bundle is verifiable
against `EXPECTED_CID`.

---

## 17. Conformance test vectors

### 17.1 Required vectors

A conformant implementation MUST pass the following vectors. Each
vector is identified by a hash of the canonical event JSON. Test
vectors live at `voyager.network/test-vectors/<id>.json` and are
mirrored at IPFS.

Initial vector set (this version):

- v01 — minimal kind:30402 listing (substrate only, no `v` tags)
- v02 — kind:30402 listing with `voyager.listing.v1` convention
- v03 — kind:30017 stall
- v04 — kind:14 `order_request` rumor (unwrapped, for test only)
- v05 — kind:1059 wrapping of v04
- v06 — kind:38383 ramp intent (buyer)
- v07 — kind:38383 Mostro quote
- v08 — end-to-end: listing → order_request → order_accept → payment_receipt → fulfilled
- v09 — Open-World Assumption: kind:30402 with unknown `v` namespace
- v10 — backward compatibility: kind:30402 mixing `voyager.tour.v1` and `voyager.listing.v1`

### 17.2 Implementation-status matrix

| Implementation | L1 | L2 | L3 | L4 | L5 |
|----------------|----|----|----|----|----|
| @voyager/sdk (TS)             | yes | yes | yes | yes | — |
| voyager-web                   | yes | yes | yes | yes | yes |
| vendor-seller-app             | yes | yes | yes | yes | yes |
| voyager-mcp                   | yes | yes | yes | yes | yes |
| voyager-idx                   | yes | yes | yes | — | — |
| voyager-mostro                | yes | yes | yes | yes | — |
| Community impl A (TBD)        | ?   | ?   | ?   | ?   | ? |
| Community impl B (TBD)        | ?   | ?   | ?   | ?   | ? |

The matrix MUST be kept current; the build process MUST fail if a
reference implementation's claimed level regresses.

---

## 18. Threat model and EROI mapping

### 18.1 Threat model

| ID | Adversary action | Mitigation |
|----|------------------|------------|
| T-1 | One relay blocks or drops events | Bootstrap ≥ 3 relays; client rotates |
| T-2 | Customer's wallet compromised | Bounded per-customer; localized |
| T-3 | Vendor's npub compromised | Bounded per-vendor; vendor re-keys and indicates successor |
| T-4 | One Mostro node colludes / evicts | Market discipline; reputation visible; route around |
| T-5 | Voyager-the-business seized or acquired | Protocol unaffected; reference clients still downloadable; community forks exist |
| T-6 | Regional network block | Relays over Tor; Mostro nodes reachable via nostr; local-install path |
| T-7 | Indexer Sybil / poisoning | Bootstrap ≥ 3 relays; clients rotate; eventually apps run own subscriptions |
| T-8 | Liquidity drought on Mostro | Voyager-mostro subsidizes early trades; multiple nodes compete |
| T-9 | Convention namespace squatting | Conventions are content-addressed via IPFS; mirrors are non-authoritative; clients recognize registered namespaces only |
| T-10 | Substrate-level validator bug | Validators reject ONLY malformed substrate fields; unknown tags are preserved |
| T-11 | A jurisdiction subpoenas Voyager-the-business for user data | Voyager-the-business has no user data; protocol has no central inbox |
| T-12 | A jurisdiction forces a Mostro node to reverse a trade | Hodl-invoice contract is cryptographic; jurisdiction cannot alter already-settled HTLCs |

### 18.2 EROI mapping

| Dimension | Contribution |
|-----------|--------------|
| F (fan-out) | Many relays; many Mostro nodes; many wallets; many vendor storage choices; many indexers; many forks |
| O (opacity) | NIP-17 gift-wraps; no KYC inside protocol; Lightning chain opaque to casual inspection; no central inbox |
| B (binding) | Every meaningful action requires a local key signature; Mostro operator can't redirect; NWC scoped; convention namespaces immutable |

Per the EROI-defense rubric at /home/tk/rubric/rubrics/eroi_defense_rubric.md,
the substrate-level profile is (3, 3, 3) — the rubric ceiling. Reference
implementations MAY inherit this profile; they MUST NOT regress it.

### 18.3 Adversarial plays with EROI < 1

- **Hostile acquirer of Voyager-the-business**: gets GitHub, npm, docs,
  indexer, brand. Cannot get user accounts (none exist), user funds
  (no custody), user data (none held). EROI < 1.
- **Jurisdictional de-platforming**: blocks domain, docs hosting,
  relays. Cannot prevent wallets running locally or relays operating
  elsewhere. EROI < 1 against a single jurisdiction.
- **Indexer poisoning**: degrades discoverability only. EROI ≈ 1
  sustained; the platform survives by client-side relay rotation.

---

## 19. What this RFC explicitly does NOT solve

These are out of scope by design, and should remain out of scope:

- Long-horizon dispute precedence across Mostro nodes (per-node
  arbitration, by design).
- Money-laundering controls at the fiat perimeter (the operator of
  each fiat rail is responsible).
- Automated credit / underwriting / BNPL — requires data the protocol
  refuses to keep.
- AMM-style instant fiat↔sats swap (Mostro is a market-maker flow;
  AMMs are out of scope for v1).
- Identity verification (intentionally offloaded to ramps and fiat
  rails per I-2).
- Vendor discovery ranking / reputation aggregation — clients do
  this locally; the protocol does not provide a "trust score" field.

---

## 20. Change-log

- v0.4.0  — initial RFC. Folds VOYAGER_PROTOCOL.md (v3) and
            EXTENSIBILITY_TAGS_THESIS.md (v3.1) into a single normative
            document. Adds JSON-Schema (Appendix A), test vectors
            (§17), SDK contract (§14), conformance levels (§4).
            Status: DRAFT (target: PROPOSED after alpha build).
- v3.1    — (predecessor) Tags thesis. Substrate vs. conventions split,
            `v` tag prefix, three illustrative conventions.
- v3.0    — (predecessor) Initial protocol-shaped form. Lightning,
            Mostro, Nostr keys; no Crossmint dependency.
- v2.x    — superseded (see EROI_AUDIT_v2.md, historical)
- v1.x    — superseded (see EROI_AUDIT.md, historical)

---

# Appendix A — JSON-Schema

The following schemas are normative for substrate event validation.
A conformant validator MUST accept events that match these schemas.
A conformant validator MUST accept events that match these schemas
AND carry additional unknown tags (Open World Assumption, §9.4).

## A.1 kind:30402

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "voyager://schemas/30402.json",
  "title": "Voyager Listing (kind:30402)",
  "type": "object",
  "required": ["kind", "pubkey", "created_at", "tags"],
  "properties": {
    "kind": { "const": 30402 },
    "pubkey": { "type": "string", "minLength": 1 },
    "created_at": { "type": "integer", "minimum": 0 },
    "content": { "type": "string" },
    "tags": {
      "type": "array",
      "items": { "type": "array", "items": { "type": "string" } },
      "minItems": 3,
      "contains": {
        "type": "array",
        "minItems": 2,
        "prefixItems": [
          { "const": "d" },
          { "type": "string", "minLength": 1 }
        ]
      }
    }
  },
  "allOf": [
    {
      "description": "MUST include d, title, price",
      "properties": {
        "tags": {
          "allOf": [
            { "contains": { "type": "array", "prefixItems": [{"const":"d"}, {"type":"string"}] } },
            { "contains": { "type": "array", "prefixItems": [{"const":"title"}, {"type":"string"}] } },
            { "contains": { "type": "array", "prefixItems": [{"const":"price"}, {"type":"string"}, {"type":"string"}] } }
          ]
        }
      }
    }
  ]
}
```

## A.2 kind:30017

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "voyager://schemas/30017.json",
  "title": "Voyager Stall (kind:30017)",
  "type": "object",
  "required": ["kind", "pubkey", "created_at", "tags"],
  "properties": {
    "kind": { "const": 30017 },
    "pubkey": { "type": "string", "minLength": 1 },
    "created_at": { "type": "integer", "minimum": 0 },
    "content": { "type": "string" },
    "tags": {
      "type": "array",
      "minItems": 2,
      "items": { "type": "array", "items": { "type": "string" } }
    }
  },
  "allOf": [
    { "description": "MUST include d and name" }
  ]
}
```

## A.3 kind:14 (rumor inside NIP-17 gift-wrap)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "voyager://schemas/14.json",
  "title": "Voyager Order Rumor (kind:14)",
  "type": "object",
  "required": ["kind", "pubkey", "content", "tags"],
  "properties": {
    "kind": { "const": 14 },
    "pubkey": { "type": "string", "minLength": 1 },
    "content": { "type": "string", "minLength": 1 },
    "tags": {
      "type": "array",
      "items": { "type": "array", "items": { "type": "string" } }
    }
  }
}
```

## A.4 kind:1059 (NIP-17 gift-wrap)

The kind:1059 wrapper itself follows NIP-17; this RFC does not
re-specify it. A conformant implementation MUST use a NIP-17 library
that produces spec-compliant gift-wraps.

## A.5 kind:38383 (ramp intent + quote)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "voyager://schemas/38383.json",
  "title": "Voyager Ramp Event (kind:38383)",
  "type": "object",
  "required": ["kind", "pubkey", "created_at", "tags"],
  "properties": {
    "kind": { "const": 38383 },
    "pubkey": { "type": "string", "minLength": 1 },
    "created_at": { "type": "integer", "minimum": 0 },
    "content": { "type": "string" },
    "tags": {
      "type": "array",
      "items": { "type": "array", "items": { "type": "string" } }
    }
  }
}
```

A kind:38383 event is recognized as an **intent** if it carries `s`
and `amt` tags; as a **quote** if it carries a `ref` tag pointing at
an intent id.

---

# Appendix B — Worked examples

## B.1 — A physical-goods listing (kind:30402 with `voyager.listing.v1`)

```json
{
  "kind": 30402,
  "pubkey": "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2",
  "created_at": 1760000000,
  "content": "Fresh whole snapper, line-caught this morning. Pickup at the dock or courier within Kingston metro.",
  "tags": [
    ["d", "snapper-2026-09-04-001"],
    ["title", "Fresh whole snapper"],
    ["price", "42000", "sats"],
    ["image", "ipfs://bafy...snapper.jpg"],
    ["t", "seafood"],
    ["t", "fish"],
    ["v", "voyager.listing.v1", "duration_minutes", "120"],
    ["v", "voyager.listing.v1", "shipping_zone", "kingston"],
    ["v", "voyager.listing.v1", "delivery_method", "pickup,courier"],
    ["v", "voyager.listing.v1", "price_alt_USD", "25", "USD"],
    ["v", "voyager.listing.v1", "stock", "8"],
    ["v", "voyager.listing.v1", "perishable", "true"]
  ]
}
```

## B.2 — A tour (kind:30402 with `voyager.tour.v1`)

```json
{
  "kind": 30402,
  "pubkey": "<guide npub>",
  "created_at": 1760000100,
  "content": "3-day southern coast motorcycle tour. Includes bike, fuel, accommodation.",
  "tags": [
    ["d", "tour-2026-12-01-south-coast"],
    ["title", "South Coast Motorcycle Tour (3 days)"],
    ["price", "1500000", "sats"],
    ["image", "ipfs://bafy...tour.jpg"],
    ["v", "voyager.tour.v1", "duration_days", "3"],
    ["v", "voyager.tour.v1", "group_size", "6"],
    ["v", "voyager.tour.v1", "meeting_point", "Negril Lighthouse"],
    ["v", "voyager.tour.v1", "difficulty", "moderate"],
    ["v", "voyager.listing.v1", "delivery_method", "digital"]
  ]
}
```

## B.3 — An accommodation (kind:30402 with `voyager.accommodation.v1`)

```json
{
  "kind": 30402,
  "pubkey": "<host npub>",
  "created_at": 1760000200,
  "content": "Two-bedroom apartment, ocean view, walk to beach.",
  "tags": [
    ["d", "apt-2026-12-01-apt2b"],
    ["title", "Ocean-view apartment, 2BR"],
    ["price", "350000", "sats"],
    ["v", "voyager.accommodation.v1", "check_in", "2026-12-01"],
    ["v", "voyager.accommodation.v1", "check_out", "2026-12-08"],
    ["v", "voyager.accommodation.v1", "guests", "4"],
    ["v", "voyager.accommodation.v1", "unit_type", "apartment"]
  ]
}
```

## B.4 — Open-World example

```json
{
  "kind": 30402,
  "pubkey": "<vendor npub>",
  "created_at": 1760000300,
  "content": "Custom future thing.",
  "tags": [
    ["d", "future-001"],
    ["title", "Whatever comes next"],
    ["price", "10000", "sats"],
    ["v", "voyager.something_we_havent_imagined.v1", "field", "value"]
  ]
}
```

A conformant client MUST accept and preserve this event even though
`voyager.something_we_havent_imagined.v1` is not yet registered.

## B.5 — A ramp quote (kind:38383)

```json
{
  "kind": 38383,
  "pubkey": "<mostro-node npub>",
  "created_at": 1760000400,
  "content": "",
  "tags": [
    ["d", "quote-001"],
    ["ref", "intent-001"],
    ["z", "voyager.ramp.v1", "fee_sats", "500"],
    ["z", "voyager.ramp.v1", "maker_pubkey", "<peer npub>"],
    ["z", "voyager.ramp.v1", "method", "wise"],
    ["z", "voyager.ramp.v1", "rate_sats_per_unit", "20.0"],
    ["z", "voyager.ramp.v1", "reputation", "0.92"]
  ]
}
```

---

# Appendix C — Migration notes from v3 protocol + v3.1 thesis

This RFC supersedes two documents:

- `VOYAGER_PROTOCOL.md` (v3.0) — the v3 protocol-era spec
- `EXTENSIBILITY_TAGS_THESIS.md` (v3.1) — the tags thesis

Both remain on disk as historical references. The substantive
differences:

| Topic | v3.0 protocol | v3.1 thesis | This RFC |
|-------|---------------|-------------|-----------|
| Document role | Spec | Addendum proposing `v` tag prefix | Single canonical RFC |
| Conformance language | Informal | Informal | RFC 2119 (MUST/SHOULD/MAY) |
| Conventions layer | Absent | Proposed | §9 normative |
| JSON-Schema | Inline JSON examples | None | Appendix A |
| Test vectors | None | None | §17 |
| SDK surface | Mentioned | Not addressed | §14 normative |
| Threat model | Inline table | Not addressed | §18 expanded with T-IDs |
| MCP boundary | Not addressed | Not addressed | §1.2 + §14.7 |
| Conformance levels | None | None | §4.1 (L1–L5) |

Implementers of v3.0 or v3.1 SHOULD migrate to this RFC. Migration is
mechanical:

1. Substrate event schemas are unchanged; existing events validate
   under Appendix A.
2. Convention tags are unchanged; existing `v` tags validate under §9.
3. The SDK API surface in §14 is a superset of the SDK notes in
   v3.0; existing SDK calls remain valid.
4. The kind:38383 ramp events gain a `z` (Voyager-ramp) tag
   namespace instead of bare tags. Existing Mostro events are still
   valid event-shape-wise, but Voyager bridges SHOULD prefer the `z`
   namespace for new quotes.

No migration event is required. Both old and new events coexist on
the network. Clients MUST apply Open World Assumption (§9.4) to both.

---

## End of RFC
