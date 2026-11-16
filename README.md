# Thumbprint

Your account can be hacked. Your identity can't.

Crypto accounts on X approve each post with a fingerprint on a Solana Seeker. A Chrome
extension shows readers which posts were approved, and warns when an account that signs its
posts publishes one that was not: the hijacked account posting a drainer link.

**Live: [thumbprint.pyras.org](https://thumbprint.pyras.org)**. Built for the UBC 2026 hackathon. Runs on Solana devnet.

The extension talks to the live server out of the box, so loading it is enough to see marks on X.

## What it does

- **Link once.** The owner publishes one post carrying their device's code, then confirms in the
  Seeker's wallet. That hands approval to a key inside the Thumbprint app that only a
  fingerprint can use. One Seeker protects one handle.
- **Approve each post.** A small button next to Post in X's composer sends the draft to the
  paired Seeker. The phone shows the text, with each link reduced to the site it points to, the
  owner approves with a fingerprint, the approval lands on Solana, and the extension presses Post.
- **Read.** Approved posts get a fingerprint mark next to the author's name. Hovering shows when
  and on which device, with a link to a public proof page.
- **Official addresses.** When an approved post names a Solana address (a token mint, a
  contract), the program records it in an account at a known address. The extension marks that
  address green in anyone's post, and warns when the same account posts a different one unsigned.
  A wallet or another program can make the same check with no server involved, and
  [thumbprint.pyras.org/check](https://thumbprint.pyras.org/check) does exactly that from the browser.
- **Warn.** A post with no approval, from an account that signs, is marked "Not signed". If it
  carries links they are blocked until the reader chooses to open them.
- **Kill switch.** One tap on the Seeker marks the account compromised for every reader, even
  while someone else controls the X session: a warning on the profile, and on every post made
  without the device.

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
| Program | `programs/thumbprint` | Anchor program: `bind`, `attest`, `endorse`, `check`, `set_compromised`, `set_approver` |
| Server | `server/` | Bun: pairing relay, fee payer, indexer, lookup API, proof pages |
| Phone page | `phone/` | The app's screen; in Chrome it does the one wallet step through Mobile Wallet Adapter |
| App | `android/` | Android app: the phone page plus a fingerprint-only Ed25519 key in secure hardware |
| Extension | `extension/` | Manifest V3 Chrome extension for x.com |
| Stream filter | `quicknode/filter.js` | QuickNode Stream filter function |

## How Solana is used

Program ID (devnet): `EerbNxsSbeADJLet2sYBZwC9eKmQPYDv3UaohaMRmriS`

- **The device signs words, the program checks them.** The Seed Vault wallet only signs
  transactions for the network it is set to, and the Genesis Token lives on mainnet. So the
  Seeker signs a readable message, for example `Thumbprint: approve this post as x:name` followed
  by the post text. The server puts that signature in an Ed25519 precompile instruction and the
  program reads it back through the instructions sysvar, checking the key and rebuilding the
  expected message itself. The post hash that is recorded is computed onchain from the signed
  text. The device account stores the wallet that linked it and every later action must carry
  that wallet's signature, so the server pays fees but cannot record anything the device did
  not sign.
- **Seeker Genesis Token.** A device is identified by its Genesis Token mint, and its account is
  a PDA of that mint: one device, one handle. The program verifies the token (Token-2022 group
  member of the Genesis group, held by the signer). On devnet that check is compiled out with
  the `devnet` feature because the token only exists on mainnet, and the indexer performs the
  same check against mainnet over RPC. The localnet tests run the real check against a Genesis
  Token mint cloned from mainnet.
- **Handle claims.** A handle is a PDA, so it can be linked once. Linking also needs the
  verifier key's signature, which the server gives only after reading a public post from that
  handle carrying the device's code (`server/proof.ts`).
- **Fingerprint only.** The Seed Vault wallet accepts a PIN, and a PIN can be typed by a script
  or a thief. So the wallet signs once, at linking, to name an approval key (`Device.approver`).
  That key is generated inside the phone's secure hardware by the app (`android/`), cannot be
  exported, signs only after a fingerprint match, and is destroyed if a fingerprint is added to
  the phone. `attest` and `set_compromised` accept that key alone; `set_approver` lets the
  wallet move approval to a new key if it is lost.
- **Addresses other programs can read.** `endorse(address)` is `attest` for a post that names a
  Solana address. The program checks that the address appears in the text the fingerprint key
  signed, then creates an `Endorsement` account at seeds `["address", handle, address]`. Anyone
  can derive that address and see whether it exists: a wallet before a swap, or a program
  through an account constraint. The server chooses which instruction to send but cannot
  record an address the owner did not approve. `GET /v1/address/<address>` is the same lookup
  over HTTP.
- **Kill switch.** `set_compromised` signs a message with a counter stored on the device
  account, so a captured signature cannot be replayed. The result is stored in a `Status`
  account at seeds `["status", handle]`.
- **A check anyone's transaction can carry.** `check(handle, address)` fails with
  `NeverApproved` or `ReportedCompromised` unless the handle's phone approved that address and
  the account is not reported as taken over. Put in front of a swap, claim or mint, it reverts
  the whole transaction; a program can instead take the two accounts in its own constraints.
  `site/check.html` runs it as a dry run against a public RPC node, with no Thumbprint server.

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

With `STREAM_TOKEN` set, the Stream is the only way records reach the server: the RPC poller
is off and the server does not read back its own transactions. Without it, the server polls
the public RPC, which is what local development uses.

## Setup

Needs [Bun](https://bun.sh), pnpm and Chrome. The program also needs Rust, the Solana CLI,
Anchor 0.31.1 and Node 22.18 or newer (the tests run as TypeScript under `node --test`).

```sh
git clone https://github.com/joeykokinda/thumbprint && cd thumbprint
pnpm install
bun test                                  # link normalization, proof post, Stream filter
THUMBPRINT_DEV=1 bun server/index.ts      # http://localhost:8787, uses the deployed devnet program
```

**See it on x.com without a phone.** Load the extension (`chrome://extensions`, Developer mode,
Load unpacked, pick `extension/`), then seed records on the dev server:

```sh
bun server/dev.ts certify x:somehandle "the exact text of one of their posts"   # green mark
bun server/dev.ts protect x:somehandle                                          # their other posts read as not signed
```

**Run the real flow.** The deployed program only accepts new links co-signed by our verifier
key, so to link accounts yourself deploy your own copy:

```sh
solana-keygen new -o target/deploy/thumbprint-keypair.json --force
anchor keys sync                          # writes the new program ID into lib.rs and Anchor.toml
# put your wallet's address in VERIFIER (devnet) in programs/thumbprint/src/lib.rs
anchor build -- --features devnet && cp target/idl/thumbprint.json server/idl.json
solana program deploy target/deploy/thumbprint.so --program-id target/deploy/thumbprint-keypair.json -u devnet
THUMBPRINT_DEV=1 bun server/index.ts
bun server/smoke.ts                       # links a throwaway key, approves a post, looks it up
```

The server pays fees and rent from `~/.config/solana/id.json`; fund it at
[faucet.solana.com](https://faucet.solana.com).

**App.** `android/build.sh` builds `site/thumbprint.apk` with the Android SDK build tools alone
(no Gradle); install it with `adb install`. It loads the live server's phone page.

**Phone.** With a Seeker on USB, `adb reverse tcp:8787 tcp:8787`, then scan the pairing code in
the extension popup. Without a Seeker, open
`http://localhost:8787/phone?session=test&signer=software` for a test key held by the page
(dev mode only).

**Program tests.** `anchor test` runs on localnet with the real Genesis Token check, against a
Genesis Token mint cloned from mainnet.

| Variable | Default | Meaning |
| --- | --- | --- |
| `THUMBPRINT_DEV` | off | `1` allows the test signer, linking without a proof post, and `/dev/*` routes |
| `PORT` | `8787` | Port to listen on |
| `PUBLIC_URL` | `http://localhost:8787` | Address used in pairing codes and proof links |
| `DATABASE` | `thumbprint.sqlite` | Index file |
| `PAYER_KEYPAIR` | `~/.config/solana/id.json` | Fee payer and verifier key |
| `X_CONSUMER_KEY`, `X_CONSUMER_SECRET` | unset | Turns on "Sign in with X" for proving handle control (callback `{PUBLIC_URL}/auth/x/callback`); without them linking uses a proof post |
| `STREAM_TOKEN` | unset | Shared secret for the QuickNode webhook; makes the Stream the only data source |
| `POLL` | on | `0` turns off the RPC polling fallback |
| `PROGRAM_RPC`, `MAINNET_RPC` | public endpoints | RPC for the program and for the Genesis Token check |

## Limits

- Only Seeker owners can sign, and only readers with the extension see anything.
- One trusted verifier vouches for handle control, and it reads X's public embed endpoint.
- Links are bound by domain, not full path, because X rewrites them.
- Someone who holds the phone and knows the wallet PIN can move approval to a key of their own.
- The kill switch is also a lever: whoever can use it can make checked transactions fail.
- One address is recorded per post, there is no way to withdraw one, and no wallet reads these records yet.
- The extension depends on X's page structure.
- A post longer than one transaction can carry (about 600 bytes) cannot be approved yet.
- Posts cut off by "Show more" get no mark in the timeline.

## License

MIT
