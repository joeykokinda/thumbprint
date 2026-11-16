# Thumbprint

Your account can be hacked. Your identity can't.

Crypto accounts on X approve each post with a fingerprint on a Solana Seeker. A Chrome
extension shows readers which posts were approved, and warns when an account that signs its
posts publishes one that was not: the hijacked account posting a drainer link.

Built for the UBC 2026 hackathon. Runs on Solana devnet.

## What it does

- **Link once.** The owner publishes one post carrying their device's code, then confirms with a
  fingerprint. One Seeker protects one handle.
- **Approve each post.** A small button next to Post in X's composer sends the draft to the
  paired Seeker. The phone shows the exact text, the owner approves with a fingerprint, the
  approval lands on Solana, and the extension presses Post.
- **Read.** Approved posts get a fingerprint mark next to the author's name. Hovering shows when
  and on which device, with a link to a public proof page.
- **Warn.** A post with no approval, from an account that signs, is marked "Not signed". If it
  carries links they are blocked until the reader chooses to open them.
- **Kill switch.** One tap on the Seeker marks the account compromised for every reader, even
  while someone else controls the X session.

Readers need only the extension. Only accounts that want protection need a Seeker.

The claim is narrow: the holder of a specific Seeker physically approved this exact text for
this handle. It does not say who wrote the text or whether it is true.

## Architecture

```
 X composer (laptop)            Seeker (Chrome + Seed Vault)         Solana devnet
 extension/content.js  --text--> phone/app.ts                         programs/thumbprint
        |                          shows text, signs a readable             ^
        |                          message with a fingerprint               |
        v                                   |                               |
 server/index.ts  <----- message + signature                               |
   relay, fee payer  ---- transaction: Ed25519 proof + program call -------+
   indexer, lookup   <--- QuickNode Stream (program transactions) ---------+
        ^
        |  lookup(handle, sha256(text))
 extension on every reader's timeline
```

| Part | Path | Role |
| --- | --- | --- |
| Program | `programs/thumbprint` | Anchor program: `bind`, `attest`, `set_compromised` |
| Server | `server/` | Bun: pairing relay, fee payer, indexer, lookup API, proof pages |
| Phone page | `phone/` | Web page on the Seeker, talks to Seed Vault through Mobile Wallet Adapter |
| Extension | `extension/` | Manifest V3 Chrome extension for x.com |
| Stream filter | `quicknode/filter.js` | QuickNode Stream filter function |

## How Solana is used

Program ID (devnet): `BYeu5eZoiHT7JWYbaECxWdi3awPKMoZspYnnEN5uHUjc`

- **The device signs words, the program checks them.** The Seed Vault wallet only signs
  transactions for the network it is set to, and the Genesis Token lives on mainnet. So the
  Seeker signs a readable message, for example `Thumbprint: approve this post as x:name` followed
  by the post text. The server puts that signature in an Ed25519 precompile instruction and the
  program reads it back through the instructions sysvar, checking the key and rebuilding the
  expected message itself. The post hash that is recorded is computed onchain from the signed
  text. The server pays fees but cannot record anything the device did not sign.
- **Seeker Genesis Token.** A device is identified by its Genesis Token mint, and its account is
  a PDA of that mint: one device, one handle. The program verifies the token (Token-2022 group
  member of the Genesis group, held by the signer). On devnet that check is compiled out with
  the `devnet` feature because the token only exists on mainnet, and the indexer performs the
  same check against mainnet over RPC. The localnet tests run the real check against a Genesis
  Token mint cloned from mainnet.
- **Handle claims.** A handle is a PDA, so it can be linked once. Linking also needs the
  verifier key's signature, which the server gives only after reading a public post from that
  handle carrying the device's code (`server/proof.ts`).
- **Kill switch.** `set_compromised` signs a message with a counter stored on the device
  account, so a captured signature cannot be replayed.

## QuickNode Stream

The indexer's data source is one Stream:

- **Network:** Solana devnet
- **Dataset:** Block
- **Filter:** `quicknode/filter.js`. Keeps successful transactions whose logs show an invoke of
  the Thumbprint program, forwards `{ signature, blockTime, logs }` for each, and returns `null`
  for every other block.
- **Destination:** webhook, `POST {PUBLIC_URL}/v1/stream?token={STREAM_TOKEN}`. The server
  decodes the Anchor events in the logs (`Bound`, `Attested`, `Flagged`) and updates the lookup
  table the extension reads.

Without `STREAM_TOKEN` the server falls back to polling the public RPC, which is what local
development uses.

## Setup

Needs [Bun](https://bun.sh), pnpm, Chrome, and for the program Rust, Solana CLI and Anchor 0.31.1.

```sh
pnpm install
THUMBPRINT_DEV=1 bun server/index.ts      # http://localhost:8787, uses the deployed devnet program
bun server/smoke.ts                       # links a throwaway key, approves a post, looks it up
```

The server pays transaction fees from `~/.config/solana/id.json` (override with
`PAYER_KEYPAIR`); it needs a little devnet SOL. Linking a handle on the deployed program needs
the verifier key, so to link accounts yourself deploy your own copy with your key in `VERIFIER`.

Extension: open `chrome://extensions`, turn on Developer mode, Load unpacked, pick `extension/`.

Phone, with a Seeker on USB:

```sh
adb reverse tcp:8787 tcp:8787
```

Then open the extension popup and scan the pairing code with the Seeker. Without a Seeker,
open `http://localhost:8787/phone?session=<session>&signer=software` to use a test key held by
the page (dev mode only).

Program:

```sh
anchor test                               # localnet, real Genesis Token check
bun test                                  # proof post and Stream filter checks
anchor build -- --features devnet && cp target/idl/thumbprint.json server/idl.json
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `THUMBPRINT_DEV` | off | `1` allows the test signer and `/dev/*` routes |
| `PUBLIC_URL` | `http://localhost:8787` | Address used in pairing codes and proof links |
| `STREAM_TOKEN` | unset | Shared secret for the QuickNode webhook |
| `POLL` | on | `0` turns off the RPC polling fallback |
| `PROGRAM_RPC`, `MAINNET_RPC` | public endpoints | RPC for the program and for the Genesis Token check |

## Limits

- Only Seeker owners can sign, and only readers with the extension see anything.
- One trusted verifier vouches for handle control, and it reads X's public embed endpoint.
- Links are bound by domain, not full path, because X rewrites them.
- Someone who holds the phone and can unlock it can sign.
- The extension depends on X's page structure.
