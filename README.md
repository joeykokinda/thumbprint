# Thumbprint

A stolen X session should not be enough to authorize a project's payments.

Thumbprint separates a project's social login from its approval key. The Seeker
holds a hardware-protected P-256 signing key. Enrollment validates Android key
attestation off-device, including hardware-enforced biometric authentication for
every signature. Solana verifies subsequent signatures and enforces explicit
payment destination approvals.

Public deployment: [thumbprint.pyras.org](https://thumbprint.pyras.org).
Network: **Solana devnet; test funds only**.

Build progress, acceptance criteria and open items: [TODO.md](TODO.md).
Hardware policy and setup: [attestation/README.md](attestation/README.md).

## Evidence on devnet

Every result below is a real transaction that anyone can inspect.

| What happened | Transaction |
| --- | --- |
| A buyer paid 1,000 lamports to the treasury the Seeker approved | [4MoSozd2…](https://explorer.solana.com/tx/4MoSozd2LwrkbaAw6EWaZSPWhZjfjDogkLJSnt9CzjbBYdWiM3XYjshrPW2YrgooVonN8btLxmFAUiQq98HQe8PW?cluster=devnet) |
| The same payment with a substituted recipient failed `WrongRecipient` and moved nothing | [xS7pap2Z…](https://explorer.solana.com/tx/xS7pap2ZAaybiMJMB3TL9aYvEpDBJ3y26u8uKCq2HBSaAoqEfrgYL6tr7bMD2chmnpWrZvyebRzjJkXvGk7Wuar?cluster=devnet) |

The enrolled key was generated on a physical Seeker and its Android attestation
chain was validated off-device. The receipt is served at
`/v1/enrollment/evidence/<digest>` and its digest is stored onchain. `/demo`
shows these results without a wallet or an extension.

## Core flow

1. Connect the Seeker wallet and prove control of the project's X handle.
2. Generate an attested biometric key. The server checks its certificate chain,
   Google trust roots and live revocation status, app signing identity, locked
   verified boot, hardware origin, and biometric-only per-operation signing policy.
3. Prove possession with a biometric signature. The wallet approves the exact key
   and evidence digest; the enrollment verifier co-signs its onchain registration.
4. Explicitly approve a treasury recipient for up to seven days. The app defaults
   to 24 hours and shows the complete signed message in a native review screen.
5. Open `/pay?handle=x:project`. The page reads authorization directly from Solana.
   Its `pay` instruction validates the actual transfer recipient, expiry,
   revocation, key generation, and emergency suspension before transferring SOL.
6. Revoke or replace a destination, suspend payments, or recover onto another
   attested key. Key replacement invalidates earlier destination approvals and
   cannot remove a suspension or resurrect a revoked approval.

Post approval is separate: signing “Do not buy ADDRESS” never authorizes ADDRESS.
Signed post text retains complete URL paths and queries. The extension uses full
expanded-link metadata when available; it cannot mark a truncated/unresolved
link as matching the author's full signed URL.

### One fingerprint per publication

The signed post text travels inside the approval transaction itself, so the exact
words are on Solana and the proof page reads them from there, not from our server.
Each approval carries a counter that the program consumes, so a captured signature
cannot be submitted a second time. Readers then compare X's own publication time
with the approval's block time: a mark is shown only for a post published within
15 minutes after its approval. Reposting the same words later needs a new
fingerprint. An attacker holding the X session can at most repeat the already
approved text inside that window.

## Architecture

| Part | Path | Responsibility |
| --- | --- | --- |
| Android app | `android/` | Attested P-256 key, native message review, per-operation biometric prompt |
| Phone UI | `phone/` | Wallet linking, enrollment, post approval, destination approval, revocation, suspension |
| Enrollment verifier | `attestation/` | Google's maintained verifier plus Thumbprint's app and authentication policy |
| Relay/indexer | `server/` | Handle proof, enrollment challenges/tickets, fee payer, receipts, post lookup |
| Solana program | `programs/thumbprint/` | Wallet/attested-key signature verification, authorization state, guarded transfers |
| Reader UI | `extension/`, `site/` | X marks, public evidence, direct-RPC protected payment page |
| Stream | `quicknode/` | QuickNode program-transaction filter and authenticated webhook ingestion |

Program ID: `EerbNxsSbeADJLet2sYBZwC9eKmQPYDv3UaohaMRmriS`.
Wallet messages use the Ed25519 precompile; biometric messages use Solana's
secp256r1/P-256 precompile with canonical low-S signatures. Signed control messages
include the network, deployment ID, action, and counter. The program binds the
payment check to the actual recipient of its own System Program transfer CPI.

The wallet can only link a handle and, together with the enrollment verifier,
register an attested key. It cannot approve posts, destinations or suspension:
those need the fingerprint key. There is no instruction that turns an address
mentioned in a post into a payment approval.

## Local setup

Requires Bun, pnpm, JDK 21, the Android SDK, Rust, Solana CLI, Anchor 0.31.1,
and Node 22.18 or newer for contract tests.

```sh
pnpm install
./attestation/build.sh
# Build the release APK; existing app signing keystore is reused.
android/build.sh
# Read the public signing certificate fingerprint, not the APK file hash:
$ANDROID_HOME/build-tools/35.0.0/apksigner verify --print-certs site/thumbprint.apk
# Configure THUMBPRINT_APP_SHA256 with that SHA-256 certificate fingerprint.
THUMBPRINT_APP_SHA256=<certificate-fingerprint> bun server/index.ts
```

The server defaults to port 8787. Its payer/verifier key defaults to
`~/.config/solana/id.json`; the deployed program only accepts its configured
verifier. Running your own deployment requires configuring that verifier and
synchronizing the program ID/IDL. Do not commit signing material.

For an isolated phone preview, `THUMBPRINT_ORIGIN=http://localhost:8791
android/build.sh` produces a test APK with loopback cleartext access and WebView
debugging enabled. Use `adb reverse tcp:8791 tcp:8791`. The release build uses the
public HTTPS origin, disables WebView debugging, and does not enable cleartext.
The test build uses the same app/key storage; replacing the biometric key still
requires wallet-authorized registration. Keep preview APKs separate from release artifacts.

## Verification

```sh
bun test                       # exact URL binding, signature encoding, amount parsing, input validation
pnpm exec tsc --noEmit
anchor test                    # actual P-256 proofs and transfers on localnet
android/build.sh
```

Contract integration tests cover verifier-gated enrollment, replay of enrollment,
destination and post approvals, wallet/PIN
signatures being rejected as approvals, modified messages, negative address
mentions, mismatched recipient/handle/deployment, expiry bounds, actual balances,
revocation, replacement, suspension, execution-time expiry, and key rotation.
Localnet tests use a verifier-controlled test key to exercise the onchain policy;
they do not substitute for physical hardware attestation tests.

Use tiny payments into already funded demo recipients. A previously nonexistent
recipient may need the network's minimum rent-exempt funding, even for a valid
transfer. Program upgrades temporarily fund a deployment buffer; the buffer's
rent returns after the upgrade, while increased program storage remains funded.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PORT`, `PUBLIC_URL`, `DATABASE` | HTTP listener, public links, SQLite index/evidence |
| `PAYER_KEYPAIR` | Fee payer and enrollment/handle verifier |
| `THUMBPRINT_APP_SHA256` | Required expected APK signing certificate SHA-256 fingerprint |
| `PROGRAM_RPC`, `MAINNET_RPC` | Program network and Genesis Token ownership checks |
| `STREAM_TOKEN` | Authenticates QuickNode webhook; disables polling fallback when set |
| `POLL=0` | Disables polling, useful for isolated local tests |
| `X_CONSUMER_KEY`, `X_CONSUMER_SECRET` | Optional X sign-in; otherwise use a public proof post |
| `THUMBPRINT_DEV=1` | Enables local preview routes and test token lookup; **does not bypass hardware verification and cannot seed approved marks** |

QuickNode Streams remains an optional deployment integration until a live Stream
is configured and verified. Without `STREAM_TOKEN`, the server polls program
transactions. Financial authorization is always enforced by onchain state.

## Security boundaries

- A project must enroll before its social account is compromised. Handle control
  at enrollment does not establish the historical human owner's identity.
- Hardware registration trusts the enrollment verifier to check Android evidence.
  The program verifies its co-signature, not the certificate chain itself. Evidence
  digests are stored onchain and evidence receipts are available for inspection.
- Seeker Genesis Tokens live on mainnet. The devnet build checks their ownership
  through the enrollment/indexing server; the localnet build tests the real token
  validation with a cloned mainnet mint.
- Biometrics authenticate use of the key. They do not prove who wrote a post,
  that a project is honest, that a linked website stays unchanged, or that investing
  is safe. Hardware attestation does not eliminate all device/OS compromise risks.
- Protection applies to the guarded payment instruction. An unrelated wallet
  transaction can omit it. No external wallet-wide scam-warning integration is claimed.
- Only extension/app readers see X marks. X layout changes and incomplete link
  metadata can prevent verification; missing approval is not proof of a hack.
- The publication check relies on the time X reports for a post. A post edited on
  X long after its approval needs a new approval to keep its mark.
- Message size is bounded by a single Solana transaction. The trusted native review
  prevents approving truncated text, and cancellation produces no signature.
- Losing both the approval device and recovery-wallet authority prevents recovery.

## License

MIT. Google's downloaded verifier remains under its Apache-2.0 license.
