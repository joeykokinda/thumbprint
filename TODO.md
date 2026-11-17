# Thumbprint: hackathon task checklist

This is the implementation and submission checklist. Work in dependency order,
not by a calendar. Unchecked items are planned work, not claims that the feature
exists. Mark a task complete only when its acceptance evidence is available.

**Build standard:** close the technical gap behind each intended guarantee.
Changing wording does not complete a missing security feature. Hardware-backed
approval, full text/URL binding, secure key replacement, and actual payment
enforcement are required deliverables, not optional improvements.

## Implemented and verified in the current working tree

This is a substantial implementation, not a completed submission. Checkmarks below
are limited to work with evidence; broader end-to-end tasks remain open.

| Completed work | How it helps | Evidence |
| --- | --- | --- |
| Attested P-256 approval key on the real Seeker | Makes hardware-backed biometric enrollment enforceable rather than trusting an app-supplied public key | Google-rooted off-device verification passed; hardware enforces per-use authentication; real fingerprint possession proof and wallet-authorized onchain enrollment succeeded |
| Maintained Android certificate verifier with app/challenge/boot/authentication checks | Rejects copied or unrelated attestation and prevents silent software-key enrollment | Wrong challenge and wrong app signer rejected against the real certificate chain; malformed-input tests pass |
| Verifier-gated enrollment and key replacement | Closes wallet-only downgrade to a software approval key | Contract integration tests; legacy `set_approver` disabled; rotation invalidates existing destination approvals |
| Explicit treasury approvals with expiry, revocation and counters | A scam warning mentioning an address no longer makes it “official”; stale signed control actions cannot restore authorization | Contract tests; real 24-hour Seeker approval recorded on devnet |
| Atomic guarded SOL payment | A valid check for address A cannot be paired with an actual payment to B | Real devnet success delivered 1,000 lamports; real submitted substitution failed `WrongRecipient` and delivered zero |
| Complete-URL/text hashing | Changed paths, queries, schemes and Unicode cannot inherit the original text approval | Normalization regression tests; no domain-only approval hashing |
| Direct-RPC post-proof verification in extension, native X bridge and public proof page | An indexer response alone cannot manufacture a verified post mark | Proof parsing/handle/hash/program/rejection tests; a fresh real-device post and live X regression are still needed |
| Protected payment and evidence walkthrough pages | Judges can inspect the financial behavior without installing the extension | Desktop/mobile browser checks against live devnet state; `/pay` and `/demo` work locally; public tunnel currently fails |
| Stable phone layout and pending-action UI | Removes the overflow/repeated-scroll problem observed during testing | Real Seeker viewport and document both 400 CSS px; pending actions retain layout and inputs; repeated click automation stopped |
| Single-use post approvals bound to a publication | A captured signature cannot be replayed, and an identical repost cannot inherit an earlier approval | Program consumes a counter in every post approval; readers require X's publication time within 15 minutes after the approval's block time; contract replay test and reader window tests pass; deployed to devnet. A real-device post and live X run are still needed |
| Builds and deployment tooling | Makes the implementation reviewable and repeatable | 7 Bun tests / 53 assertions, TypeScript check, Android preview/release builds; 10 Anchor integration tests passed |

**Current blocker:** public Cloudflare Tunnel returns HTTP 530 / error 1033;
its outbound port 7844 connections time out. Phone is deliberately on the working
USB preview (`localhost:8791`), not the unavailable public origin.

**Next actions that need Rex at the phone:** approve a dedicated demo treasury
(the current approval expires November 17 and points at the server's own fee payer
key), run the suspension demonstration (`bun server/demo.ts x:spekthumbprint suspended`
after suspending, then recover), and approve one real post to check the mark on X.

## Product decision

Build Thumbprint for this submission. Keep the paid phone network as a separate
project; do not introduce a marketplace or reuse TapRig implementation here.

**Pitch:** When a project's X account gets hacked, its followers should still
know where their money is going. Thumbprint lets the project approve an official
payment destination from a separate device, and lets a participating app enforce
that approval on Solana.

**First customer:** a crypto project publishing its treasury/payment address.
**First user action:** send a devnet SOL payment to that project's approved treasury.
**Threat:** an attacker controls the project's X session, but not its enrolled
approval key or recovery wallet. The project enrolled before the takeover.

**Target guarantee:** compromising the enrolled project's X session or stealing
its session cookies cannot forge approval of changed text, URLs, or payment
destinations. Approval requires a verified hardware-protected key with biometric
authentication for every use. A participating payment checks authorization at
execution and rejects a substituted, expired, revoked, or suspended destination.

Every part of that guarantee needs implementation and adversarial evidence.
Honesty, investment returns, and universal protection across unrelated wallets
are not properties that device approval can establish.

## Submission scope

- Recommended main track: Consumer Applications. Recheck its detailed requirements
  against the completed experience before selecting it in Devpost.
- Chain award: Best use of Solana. Devnet is allowed.
- QuickNode Streams bounty only if a real Stream powers the demonstrated indexer.
- Use the existing Seeker and devnet deployment; build one complete protected
  payment experience before expanding the supported actions.

Official references, checked November 16:
[event, criteria, awards and submission requirements](https://ubc-hackathon-2026.devpost.com/),
[eligibility and dates](https://ubc-hackathon-2026.devpost.com/rules).
The event page links a detailed guide; read the relevant track and bounty sections
before final submission. Its Google Docs body was unavailable through web text extraction.
The rules prohibit pre-existing projects/codebases. Preserve accurate build history.

## What winning-quality execution looks like

One screen shows the phone approval, one shows the reader/payment experience,
and transaction links prove the financial results. The audience sees a legitimate
payment succeed, a substituted recipient fail, and emergency suspension stop a
previously allowed payment. A judge can inspect the evidence without installing
an extension, owning a Seeker, or asking us for credentials.

This is a controlled participating app. We must not claim it protects a person
who follows a malicious link and signs an unrelated transaction elsewhere.

## Task order and dependencies

P0 means required for a credible, complete submission. P1 improves adoption,
judging access, and competitive strength; it is still part of this checklist.
Optional work is listed separately and must not block the core product.

| Group | Priority | Dependency | Completion evidence |
| --- | --- | --- | --- |
| 1. Verified hardware approval | P0 | None | Attested key enrollment, biometric enforcement and rejection tests |
| 2. Explicit approval | P0 | 1 | Tested authorization, expiry and revocation |
| 3. Guarded payment | P0 | 2 | Actual successful and rejected devnet payments |
| 4. Post and phone flow | P0 | 1; integrate with 2–3 | Repeated physical runs and accurate verification |
| 5. Judge access and validation | P1 | Can draft immediately; final evidence needs 3–4 | Public walkthrough and observed user feedback |
| 6. Sponsor integration | P1 | 2 and the indexer | Real Stream delivery and recovery evidence |
| 7. Verification | P0 | Add tests alongside 2–6; final run after integration | Test results and physical evidence |
| 8. Submission and presentation | P0 | Draft immediately; finalize after 5–7 | Accessible submission and rehearsed demonstration |
| 9. Visual and interaction polish | P1 | Apply alongside 4–5 | Consistent, usable author and reader experiences |

Never replace an unbuilt enforcement path with a simulated success presented as
real execution. Product tests belong with their implementation, not in a final
testing-only phase.

## 1. Build verifiable hardware-backed approval — P0

Main files: `android/`, enrollment and recovery routes in `server/`, the program,
phone messages, and enrollment/contract tests.

- [ ] Write the attack model and turn each target guarantee into a failing test:
  stolen X session, software-generated approval key, PIN-only approval, replayed
  enrollment, changed signed content, and unauthorized key replacement.
- [x] Inspect the real Seeker's supported hardware key algorithms, attestation
  certificates, security levels, and per-operation biometric capabilities. Select
  an algorithm supported by both attested Android hardware and a verified Solana
  signature path; migrate the current Ed25519 path if the hardware cannot attest it.
  Do not attest one key and assume that proves another key has the same protections.
- [ ] Generate the approval key inside secure hardware with per-operation strong
  biometric authentication, no device-credential fallback, and invalidation on
  biometric enrollment changes. Verify the actual enforcement properties.
- [ ] Add a fresh, expiring, single-use enrollment challenge bound to the wallet,
  handle, approval public key, app/deployment domain, and intended enrollment action.
- [x] Request Android key attestation and validate it off-device using a maintained
  verifier. Check the certificate chain, accepted current roots, revocation status,
  challenge, and that the attested leaf key is exactly the proposed approval key.
- [x] Validate the hardware-enforced signing purpose, hardware security level,
  biometric-only per-use authorization, verified boot/locked-device policy, and
  expected app package/signing identity. Reject unsupported or ambiguous evidence.
  A local “hardware-backed” flag or the existence of a certificate is insufficient.
- [x] Require proof of possession of that exact key before completing enrollment.
- [x] Gate onchain key registration on the verifier's approval of that exact
  enrollment. Bind its authorization to the complete enrollment and prevent replay.
  Publish the verifier's trust role; offchain certificate checking is not an
  onchain or trustless Android certificate verifier.
- [ ] Publish a verifiable enrollment receipt binding the key, policy, evidence
  digest, and onchain registration. Expose the evidence needed for an independent
  check without publishing hardware identifiers unnecessary for verification.
- [x] Apply the same verification policy to every key-rotation/recovery path.
  The wallet must not be able to downgrade approval to an arbitrary software key.
- [ ] Test that a software key, copied attestation, altered leaf key, reused
  challenge, revoked/untrusted certificate, or unacceptable authentication policy
  cannot enroll or replace the current approval key.
- [ ] Physically show that ADB/accessibility input and a device PIN cannot unlock
  an approval operation, cancellation yields no signature, and each operation
  requires fresh biometric authentication. Test the actual Seeker rather than
  inferring these properties from an emulator or an API call succeeding.
- [ ] Keep the text being signed in the trusted native approval view. Verify that
  web content cannot substitute a different message between display and signature.
  Test long-message truncation; require a readable complete review before approval.
- [ ] Establish whether the verified policy proves a fingerprint specifically or
  a strong biometric generally. Use “fingerprint” only with evidence for that
  distinction on the supported device; certificate fields may establish less.
- [ ] Distinguish “approved,” “no approval found,” “approval expired/revoked,”
  “project suspended payments,” and “verification unavailable.” An unsigned post
  is not proof of a takeover. An RPC failure is not evidence of a malicious address.
- [x] Remove the `/check` claim that no record means the post was not made by
  the owner. Stop calling arbitrary address mentions “official addresses.”
- [x] Document trust in initial handle verification, the recovery wallet, the
  app/distribution, the server's index, and devnet Genesis Token verification.
- [x] Document that initial enrollment after a takeover does not establish the
  original owner's identity. Recovery-wallet compromise remains outside our guarantee.
- [ ] Verify Genesis Token ownership and bind the wallet to the attested approval
  key during enrollment. Keep mainnet token verification and devnet program
  verification explicit; a token alone does not attest the approval key or prove
  it resides on the same device that holds the token's wallet.
- [ ] After implementation passes its tests, update the site, README, app,
  extension, proof pages and submission to describe the verified guarantees.
  Broad slogans must not replace a precise, demonstrable security property.

**Pass:** public enrollment and rotation reject unverified keys; hardware and
per-use authentication are independently checked; a stolen X session cannot
obtain a valid approval. Tests include attempts to bypass the trusted enrollment
path. Updating copy alone does not pass this group.

Implementation references:
[Android hardware key attestation](https://developer.android.com/privacy-and-security/security-key-attestation),
[attestation fields and enforcement](https://source.android.com/docs/security/features/keystore/attestation),
[Android Keystore authentication enforcement](https://developer.android.com/privacy-and-security/keystore).

## 2. Make financial approval explicit — P0

Main files: `programs/thumbprint/src/lib.rs`, `phone/messages.ts`, `phone/app.ts`,
`server/index.ts`, `server/idl.json`, `tests/thumbprint.ts`.

- [x] Stop creating endorsements by extracting an address from arbitrary post text.
  A warning about a scam address must never authorize that address.
- [x] Add a separate “Approve payment destination” action. Limit this submission
  to one active treasury destination per handle and one purpose: treasury payment.
- [x] Define a single canonical signed message containing a format version,
  deployment/network domain, handle, recipient, purpose, expiry, and counter.
  Reconstruct and validate these fields in the program; do not trust relay parameters.
- [x] Show the complete recipient address, purpose, and expiry on the phone before
  biometric approval. The human should understand what is being authorized.
- [x] Store current authorization in program-owned state with explicit expiry and
  revocation/replacement behavior. Existing mention-based endorsements cannot
  satisfy the new guarded-payment path.
- [x] Define sensible default expiry and validate its bounds onchain. Explain
  replacement clearly and prevent old approval screens from restoring stale state.
- [x] Use a counter to prevent replay, including replay after replacement or
  revocation. Signed deployment scope must prevent acceptance by another deployment.
- [x] Add “Revoke destination.” Keep emergency suspension as a separate, reversible
  action; only the enrolled authority can change either state.
- [x] Update the server, IDL, phone, readers, check page, and proof pages together.
  Preserve a clear distinction between post approval and payment authorization.

**Pass:** a signed negative mention grants nothing; approval of address A cannot
authorize B; expired, revoked, replaced, or replayed authorization is rejected.

## 3. Enforce one real payment — P0

Main files: program and tests, a small hosted payment page, server routing.

- [x] Add a guarded devnet SOL payment instruction that checks the current
  authorization and suspension state, then transfers SOL through a System Program CPI.
- [x] Bind validation to the actual recipient account passed to the transfer.
  An approved address A must never be used to validate a transfer to B.
- [x] Require the payer's signature. Show recipient, amount, network, and project
  on the payment page and in the wallet's transaction approval.
- [x] Use the expected handle from the project's trusted context. Do not let a
  substituted link silently switch verification to an attacker's enrolled handle.
- [x] Verify expiry and suspension at execution, not only in a browser preflight.
- [ ] Show pending, confirmed, rejected, and unknown outcomes. On an ambiguous
  submission result, check its signature before offering another payment.
- [x] Use tiny, clearly labeled devnet amounts and a dedicated demo wallet.
- [x] Publish a successful payment signature and balance change, then prove a
  substituted-recipient attempt transfers no payment amount. Failed submitted
  transactions may still incur network fees; do not claim balances never change.
- [ ] Demonstrate suspension after a preview but before execution; submission
  must still reject once the suspension is confirmed onchain.
- [x] Label `/check` as an authorization lookup/simulation. Do not claim that
  passing it proves an arbitrary swap will succeed or be safe.

**Pass:** a legitimate payment actually settles; rejected paths cannot transfer
the payment amount. The server cannot bypass the program's authorization checks.

## 4. Repair post verification and complete the phone UX — P0

- [x] Prevent replay of post approval signatures and bind approval to a specific
  publication. Every post approval consumes the action counter onchain, and readers
  accept it only for a post X reports as published within 15 minutes after it.

Main files: `extension/shared.js`, `extension/content.js`, `extension/background.js`,
`phone/`, `android/`, `server/`.

- [ ] Sign complete post text and full URL values, including path and query.
  Recover X-rendered destinations from available expanded-link metadata and
  verify the signed values against the actual post. Do not discard URL components
  or rely on a link's visible label to establish its destination.
- [ ] Preserve exact signed values in a durable approval receipt that readers
  can inspect and verify independently. Support unambiguous comparison between
  a composed draft, rendered post, and receipt without lossy URL/Unicode folding.
- [ ] If X does not expose a complete destination for a particular post, provide
  its signed receipt and clearly show the unresolved comparison; do not issue an
  exact-content mark. This exception does not complete full-URL support for the
  primary demonstrated posting and reading flow.
- [ ] Test that changing URL path, query, scheme, or relevant encoded content
  cannot preserve an exact-content approval. Do not normalize distinct destinations
  into the same approval merely to make timeline matching easier.
- [ ] Preserve the composer check that editing a draft after approval requires
  a new approval. Handle cancellation and timeout without publishing.
- [ ] Verify the native signing bridge is available only to the trusted approval
  page; X content and navigation to other origins cannot directly obtain signatures.
- [ ] Physically test enrollment, explicit destination approval, cancellation,
  payment, revocation, suspension, and recovery on the actual Seeker.
- [ ] Verify that wallet-based approval-key rotation works without removing the
  suspension flag or silently restoring revoked destinations. It must also pass
  the same hardware-attestation policy as initial enrollment.
- [ ] Explain and test lost-phone recovery using the existing recovery-wallet
  authority. Require fresh device approval after rotation; show when that wallet
  is needed instead of implying one-tap recovery without it.
- [ ] If fingerprint enrollment invalidates the key, the app explains the next
  recovery step. Do not imply recovery without the required wallet authority.
- [ ] Test the X WebView login and mobile marks. If unreliable, retain the proven
  desktop extension path and demote the mobile X tab from the main demonstration.
- [ ] Run the complete critical flow five consecutive times; log timing, failures,
  and the build used. Record at least one run from a cold app launch.

**Pass:** cancellation never approves or publishes; modified content is not marked
as exact; the physical flow is reproducible without developer intervention.

## 5. Give judges access and collect product evidence — P1

- [ ] Ship one public “Try the demo” URL with a clearly labeled controlled project,
  approved destination, attacker substitution, suspension state, and proof links.
- [ ] Let a judge inspect the three financial outcomes without a wallet or
  extension. Separate recorded evidence from any interactive devnet payment option.
- [ ] Keep an authentic X flow in the video/live demonstration. Clearly label
  any recreated feed; do not present it as a live X integration.
- [ ] Keep public demonstration controls isolated from the actual enrolled
  project and recovery authority. Do not expose generic production dev endpoints.
- [ ] Show user-facing transaction status and links, with technical details in
  an expandable explanation rather than the primary action flow.
- [ ] Rex: show the flow to at least one project/operator and two potential readers.
  Ask them to explain what approval guarantees and find the authorized recipient.
  Log observed confusion, actual feedback, and fixes; do not invent endorsements.
- [ ] Write a concrete adoption story: a project enables the protected payment
  flow, shares its verified page, and links its approved destination. The hosted
  path gives value before broad extension or wallet adoption.
- [ ] Choose hosting that stays up while the laptop travels. If retaining the
  local tunnel, verify power, connectivity, restart behavior, and travel arrangements.
- [ ] Check the public experience from another device/network and a clean browser.
- [ ] Put the primary reader action on a shareable project page: expected handle,
  current recipient, approval status, expiry, and a clearly labeled protected payment.
  A reader should not need to copy addresses into an unexplained developer tool.
- [ ] Verify a published approval/proof page against public onchain state; explain
  what remains verifiable if the X post is deleted or the indexer is unavailable.

**Pass:** a new reader can identify the authorized destination and explain the
guarantee without coaching; the primary judging evidence needs no installation.

## 6. Prove the sponsor integration — P1

- [ ] Read the detailed QuickNode Streams bounty requirements.
- [ ] Configure a live devnet Stream, filter, authenticated webhook, and indexer.
- [ ] With polling fallback disabled, generate a real approval and suspension;
  confirm both reach the reader through the Stream. Save signatures and measured delay.
- [ ] Verify duplicate deliveries are harmless and demonstrate restart/replay
  behavior without stale approval state appearing current.
- [ ] Show that payment enforcement still reads onchain state when the relay or
  indexer is unavailable; avoid claiming that all enrollment/approval works offline.
- [ ] If the live Stream is not proven before submission, omit the bounty
  claim and describe the actual data path accurately.

## 7. Required verification — P0

The unit and contract tests pass (see the table above). That does
not validate the contract, Android security properties, or complete user journey.

- [x] Focused message/normalization tests for changed destinations and explicit approvals.
- [ ] Anchor integration coverage for wrong signer, missing approval, recipient
  mismatch, wrong handle/purpose/deployment scope, expiry, replay, revocation,
  replacement, suspension, recovery, and actual transfer balances.
- [x] Regression: “Do not buy ADDRESS” and ordinary signed text create no authorization.
- [x] Regression: a positive lookup for A cannot permit an actual payment to B.
- [ ] Regression: expired/revoked legacy records cannot render as currently authorized.
  Contract enforcement passes; verify every rendered reader surface as well.
- [ ] Test interrupted pairing, duplicate approval clicks, rejected wallet prompts,
  relay failure, RPC timeout, and reconnect. Each must leave a clear, recoverable
  state without accidental approval, publication, or duplicate payment.
- [ ] Verify authorization state used for the financial decision comes from the
  expected program and account addresses, even if the indexer returns stale data.
- [ ] Review modified security boundaries: webhook authentication, request size
  limits, rendered untrusted text/links, and signing-bridge origin access.
- [ ] Exercise enrollment and recovery bypass attempts against the deployed
  program directly, not just the UI. A client that skips attestation verification
  must not register an approval key accepted as hardware verified.
- [x] `bun test`, `anchor test`, relevant TypeScript checks, and Android build pass.
- [ ] Deploy the tested devnet build; synchronize program ID, IDL, clients, APK,
  documentation, and public proof links. Re-run the physical critical flow afterward.
- [ ] Record test command, date, build/commit, transaction links, and any limits
  in a small verification log. Never mark a physical check passed from an emulator run.

## 8. Record, rehearse and submit — P0

- [ ] Create the Devpost draft; verify team details and public repository access.
- [ ] Confirm the official submission requirements, deadline, presentation format,
  and in-person eligibility directly from the organizers' published material.
- [ ] Record a 2–3 minute public demo video with the real phone, successful payment,
  rejected substitution, suspension, transaction evidence, and a concise limitation.
- [ ] Prepare a five-minute presentation; confirm the final slot/Q&A format with
  organizers. Keep an offline copy of the video and screenshots of transaction evidence.
- [ ] Rehearse three times with a timer. Have someone interrupt with skeptical questions.
- [ ] Update README, landing page, screenshots, proof pages, and architecture to
  describe the final implementation. Include devnet and remaining trust assumptions.
- [ ] Explain the first buyer, how they adopt, and what an initial paid pilot would
  test. Treat pricing and demand as hypotheses until someone validates them.
- [ ] Confirm the detailed Consumer Applications and Solana requirements are met;
  select exactly one main track and the matching award/bounty opt-ins.
- [ ] Verify the public demo and video without being logged in. Remove stale links
  and check that no credentials or signing material entered the public artifacts.
- [ ] Submit before the official deadline, then verify the saved submission and links.
- [ ] Prepare the Seeker, charger, cable, laptop, demo wallet, network fallback,
  and offline recording for the in-person presentation.

## 9. Visual and interaction polish — P1

- [ ] Make the landing page explain the problem, show the product, and offer one
  obvious “Try the demo” action. Replace placeholder or contradictory screenshots.
- [ ] Give authors a short onboarding flow: connect wallet, prove handle control,
  enroll approval key, approve destination. Explain why each step is required.
- [ ] Show a persistent protected-project identity across the post, phone prompt,
  project page, and payment confirmation. Prevent accidental account switching.
- [ ] Use consistent language and visual treatment for approved, expired, revoked,
  suspended, unknown, pending, and failed states across all surfaces.
- [ ] Keep complete addresses inspectable and copyable. Identify the expected
  project prominently; never rely on a shortened address alone to establish trust.
- [ ] Make primary flows usable on desktop and phone, with keyboard navigation,
  readable contrast, touch targets, and text/icons alongside status colors.
- [x] Give waiting states progress and a next action. Cancellation, timeout, and
  retries must not leave the user guessing whether anything happened.
- [ ] Review long handles, addresses, text, missing data, and slow responses for
  broken layouts. Remove developer-only labels from the primary user experience.

**Pass:** an unfamiliar user can complete or safely cancel the core flow, explain
its result, and find the proof without needing a verbal tutorial.

## Presentation beats

- [ ] Establish the threat: a trusted project's social account publishes a
  substituted payment address.
- [ ] Show explicit phone approval and a legitimate devnet payment settling.
- [ ] Substitute the recipient; show the actual guarded payment being rejected.
- [ ] Suspend from the phone; show a previously permitted payment being rejected.
- [ ] Explain key separation, onchain enforcement, and the actual Stream integration.
- [ ] Explain the first customer, installation-free reader path, and actual feedback.
- [ ] Close with the guarantee, its boundaries, available proof, and the next integration.

Answers to rehearse: Why Solana? Why Seeker? Why isn't a signature enough?
What if the owner approves a scam? What if the wallet or phone is stolen?
What if an attacker enrolls first? What if a link changes? Can a wallet omit the
check? What happens when RPC/the server is down? Who would adopt this first?

## Final acceptance checklist

- [ ] Every P0 task is complete and has evidence; unresolved limitations are public.
- [ ] A legitimate protected payment succeeds on devnet with transaction evidence.
- [ ] Substituting the actual recipient fails and transfers no payment amount.
- [ ] Expiry, revocation, and suspension prevent execution even after a successful preview.
- [ ] Mentioning an address in a post never creates payment authorization.
- [ ] Changed links cannot receive an exact-content approval mark.
- [ ] Hardware attestation is verified off-device and bound to the registered key.
- [ ] Software-key enrollment and replacement are rejected by the enforced registration policy.
- [ ] Each supported approval requires fresh biometric authentication on the real Seeker.
- [ ] Actual Seeker approval and recovery pass the same hardware verification policy.
- [ ] A judge can inspect the core demonstration without installing software or signing in.
- [ ] The deployed build matches the tested build and the version shown in the recording.
- [ ] The product has a credible first customer and a clear adoption path.
- [ ] Presentation and public documentation explain the same final product.
- [ ] Submission, video, proof links, and deployment work from a clean browser.

## Optional work and scope boundaries

Optional after the core checklist: Chrome Web Store distribution and a fully
validated mobile X browsing experience. Verified hardware enrollment and recovery
are required core work. Do not advertise an optional capability until it has been
built and verified.

No phone marketplace, generalized swap router, custom wallet, mainnet migration,
new sponsor integrations, token launch, or broad social-network expansion in this
submission. Keep the desktop X path if it is the reproducible integration. Fix
core product failures before adding additional platforms or sponsor features.

The goal is a credible, complete product demonstration with defensible claims.
Prize outcomes depend on the field and judging; no feature checklist guarantees a win.
