// Thumbprint server: lookup API for the extension, pairing relay between laptop and phone,
// indexer for the Solana program, and proof pages. Run with: bun server/index.ts
import { Database } from "bun:sqlite";
import * as anchor from "@coral-xyz/anchor";
import QRCode from "qrcode";
import { homedir } from "node:os";
import { attestMessage, hardwareMessage } from "../phone/messages.ts";
import { proofCode, verifyProof } from "./proof.ts";
import { p256Instruction } from "./signatures.ts";
import { publishedWithinApproval } from "../lib/post-proof.ts";
import { verifyHardware } from "./enrollment.ts";
import idl from "./idl.json"; // copied from target/idl after anchor build

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const PROGRAM_RPC = process.env.PROGRAM_RPC || "https://api.devnet.solana.com";
const MAINNET_RPC = process.env.MAINNET_RPC || "https://api.mainnet-beta.solana.com";
const STREAM_TOKEN = process.env.STREAM_TOKEN; // set once the QuickNode Stream is live: it becomes the only data source
const DEV = process.env.THUMBPRINT_DEV === "1"; // enables /dev/* seeding and skips the token check
// Optional "Sign in with X" for proving handle control (OAuth 2.0 with PKCE). Without these,
// linking uses the proof post in proof.ts.
const X_CONSUMER_KEY = process.env.X_CONSUMER_KEY;
const X_CONSUMER_SECRET = process.env.X_CONSUMER_SECRET;
const SGT_GROUP = "GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const APPROVAL_TIMEOUT_MS = 120_000;
// Pays fees and account rent so the phone's wallet needs no SOL. It only ever signs
// transactions made purely of this program's instructions (see submit()).
const payer = anchor.web3.Keypair.fromSecretKey(
  Uint8Array.from(await Bun.file(process.env.PAYER_KEYPAIR || `${homedir()}/.config/solana/id.json`).json()),
);
const connection = new anchor.web3.Connection(PROGRAM_RPC, "confirmed");
const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" })) as any;

const database = new Database(process.env.DATABASE || "thumbprint.sqlite");
database.exec(`
  CREATE TABLE IF NOT EXISTS bindings (handle TEXT PRIMARY KEY, owner TEXT, sgt_mint TEXT, bound_at INTEGER);
  CREATE TABLE IF NOT EXISTS attestations (handle TEXT, text_hash TEXT, owner TEXT, sgt_mint TEXT, timestamp INTEGER, signature TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS flags (handle TEXT PRIMARY KEY, compromised INTEGER);
  CREATE TABLE IF NOT EXISTS evidence (digest TEXT PRIMARY KEY, receipt TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS post_receipts (signature TEXT PRIMARY KEY, message TEXT NOT NULL, public_key TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK (id = 1), signature TEXT);
`);
// Older index files allowed one approval per text. Each publication now needs its own.
if ((database.query("SELECT sql FROM sqlite_master WHERE name = 'attestations'").get() as any).sql.includes("PRIMARY KEY (handle, text_hash)"))
  database.transaction(() => database.exec(`
    ALTER TABLE attestations RENAME TO attestations_old;
    CREATE TABLE attestations (handle TEXT, text_hash TEXT, owner TEXT, sgt_mint TEXT, timestamp INTEGER, signature TEXT PRIMARY KEY);
    INSERT OR IGNORE INTO attestations SELECT * FROM attestations_old;
    DROP TABLE attestations_old;`))();
database.exec("CREATE INDEX IF NOT EXISTS attestations_by_text ON attestations (handle, text_hash)");

// ---- Records ----

const waiters = new Map<string, (signature: string | null) => void>(); // "handle|hash" -> resolve
const pending = new Map<string, string>(); // session -> waiter key, so the phone can reject

function saveBinding(handle: string, owner: string, sgtMint: string, boundAt: number) {
  database.run("INSERT OR IGNORE INTO bindings VALUES (?, ?, ?, ?)", [handle, owner, sgtMint, boundAt]);
}

function saveAttestation(handle: string, textHash: string, owner: string, sgtMint: string, timestamp: number, signature: string) {
  database.run("INSERT OR IGNORE INTO attestations VALUES (?, ?, ?, ?, ?, ?)", [handle, textHash, owner, sgtMint, timestamp, signature]);
  waiters.get(`${handle}|${textHash}`)?.(signature);
}

// Older index files have no record of which transaction carried the report.
for (const column of ["signature TEXT", "reported_at INTEGER"]) try { database.run(`ALTER TABLE flags ADD COLUMN ${column}`); } catch {}
const isCompromised = (handle: string) =>
  Boolean((database.query("SELECT compromised FROM flags WHERE handle = ?").get(handle) as any)?.compromised);

// Payment destinations a handle's fingerprint key explicitly approved, read from program accounts.
async function authorizationFor(handle: string) {
  if (!/^x:[a-z0-9_]{1,15}$/.test(handle)) throw new Error("Invalid X handle");
  const derive = (...seeds: Buffer[]) => anchor.web3.PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const claim = await program.account.handleClaim.fetchNullable(derive(Buffer.from("handle"), Buffer.from(handle)));
  if (!claim) return { handle, state: "not_enrolled", network: "devnet" };
  const deviceKey = deviceAddress(claim.sgtMint.toBase58());
  const [authorization, hardware, status] = await Promise.all([
    program.account.authorization.fetchNullable(derive(Buffer.from("treasury"), Buffer.from(handle))),
    program.account.hardware.fetchNullable(derive(Buffer.from("hardware"), deviceKey.toBuffer())),
    program.account.status.fetchNullable(derive(Buffer.from("status"), Buffer.from(handle))),
  ]);
  if (!authorization) return { handle, state: "no_approval", network: "devnet" };
  const expiresAt = Number(authorization.expiresAt);
  const state = status?.compromised ? "suspended" : !authorization.enabled ? "revoked" : !hardware || !authorization.generation.eq(hardware.generation) ? "key_changed" : expiresAt <= Date.now() / 1000 ? "expired" : "approved";
  return { handle, state, network: "devnet", recipient: authorization.recipient.toBase58(), expiresAt, approvedAt: Number(authorization.approvedAt), evidence: hardware ? Buffer.from(hardware.evidence).toString("hex") : null, record: derive(Buffer.from("treasury"), Buffer.from(handle)).toBase58() };
}
// ponytail: every authorization account in one request, shared by all lookups for 30 seconds, so
// a busy feed cannot multiply RPC calls. A mark can lag a revocation by that long; payments never
// read this, they check the chain themselves. Upgrade path: keep it current from the Stream.
let authorizations = { at: 0, rows: Promise.resolve([] as any[]) };
async function endorsements(address: string) {
  if (Date.now() - authorizations.at > 30_000) authorizations = { at: Date.now(), rows: program.account.authorization.all() };
  const rows = (await authorizations.rows.catch((error: unknown) => { authorizations.at = 0; throw error; })).filter(({ account }: any) => account.recipient.toBase58() === address);
  // An address mentioned in a post never counts: only an explicit, current destination approval.
  const current = await Promise.all(rows.slice(0, 8).map(({ account }: any) => authorizationFor(account.handle)));
  return current.filter((row: any) => row.state === "approved").map((row: any) => ({ address, handle: row.handle, timestamp: row.approvedAt, expiresAt: row.expiresAt, recordUrl: `${PUBLIC_URL}/pay?handle=${encodeURIComponent(row.handle)}` }));
}

async function lookup(item: { handle: string; hash: string; postedAt?: string | null; addresses?: string[] }) {
  const approved = (await Promise.all((item.addresses ?? []).slice(0, 4).map((address) => typeof address === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? endorsements(address).catch(() => []) : Promise.resolve([])))).flat(); // an RPC failure hides the address mark, never the post mark
  if (approved.length) return { ...lookupOnly(item), addresses: approved };
  return lookupOnly(item);
}

function lookupOnly(item: { handle: string; hash: string; postedAt?: string | null }) {
  // The report is itself a signed transaction, so readers get a link to it, not just our word.
  const flag = database.query("SELECT compromised, signature, reported_at FROM flags WHERE handle = ?").get(item.handle) as any;
  const report = flag?.compromised && flag.signature ? { reportedAt: flag.reported_at, reportUrl: `https://explorer.solana.com/tx/${flag.signature}?cluster=devnet` } : {};
  return { ...lookupPost(item), compromised: Boolean(flag?.compromised), ...report };
}

function lookupPost(item: { handle: string; hash: string; postedAt?: string | null }) {
  // The approval given for this publication, not any earlier approval of the same words.
  const attestation = (database
    .query("SELECT attestations.* FROM attestations INNER JOIN post_receipts USING(signature) WHERE handle = ? AND text_hash = ? ORDER BY timestamp DESC")
    .all(item.handle, item.hash) as any[]).find((row) => publishedWithinApproval(row.timestamp, item.postedAt));
  if (attestation) {
    const dayAgo = Math.floor(Date.now() / 1000) - 86_400;
    const recent = database
      .query("SELECT COUNT(*) AS count FROM attestations WHERE sgt_mint = ? AND timestamp > ?")
      .get(attestation.sgt_mint, dayAgo) as any;
    return {
      state: "certified",
      signature: attestation.signature,
      timestamp: attestation.timestamp,
      sgtMint: attestation.sgt_mint,
      recentCount: recent.count,
      proofUrl: `${PUBLIC_URL}/p/${attestation.signature}?handle=${encodeURIComponent(item.handle)}&hash=${item.hash}`,
    };
  }
  const binding = database.query("SELECT bound_at FROM bindings WHERE handle = ?").get(item.handle) as any;
  const postedAt = item.postedAt ? Date.parse(item.postedAt) / 1000 : NaN;
  // Only posts made after the account started signing can be called unsigned.
  if (binding && postedAt > binding.bound_at) return { state: "unsigned" };
  return { state: "none" };
}

// ---- Seeker Genesis Token check, over mainnet RPC ----

async function rpc(url: string, method: string, params: unknown[], attempt = 0): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  // Public endpoints rate-limit hard; back off and retry rather than fail an approval.
  if (response.status === 429 && attempt < 4) {
    await Bun.sleep(400 * 2 ** attempt);
    return rpc(url, method, params, attempt + 1);
  }
  const body = (await response.json()) as any;
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function isGenesisMint(sgtMint: string): Promise<boolean> {
  const mint = await rpc(MAINNET_RPC, "getAccountInfo", [sgtMint, { encoding: "jsonParsed" }]);
  const extensions = mint?.value?.data?.parsed?.info?.extensions ?? [];
  const member = extensions.find((extension: any) => extension.extension === "tokenGroupMember")?.state;
  return mint?.value?.owner === TOKEN_2022 && member?.group === SGT_GROUP && member?.mint === sgtMint;
}

const heldTokens = async (owner: string, filter: object) =>
  (await rpc(MAINNET_RPC, "getTokenAccountsByOwner", [owner, filter, { encoding: "jsonParsed" }])).value
    .filter((account: any) => account.account.data.parsed.info.tokenAmount.amount === "1")
    .map((account: any) => ({ tokenAccount: account.pubkey as string, mint: account.account.data.parsed.info.mint as string }));

// Positive answers are remembered: the token cannot leave its wallet, and the public RPC is slow.
const verifiedHolders = new Set<string>();
export async function holdsGenesisToken(owner: string, sgtMint: string): Promise<boolean> {
  const key = `${owner}|${sgtMint}`;
  if (verifiedHolders.has(key)) return true;
  const holds = (await isGenesisMint(sgtMint)) && (await heldTokens(owner, { mint: sgtMint })).length > 0;
  if (holds) verifiedHolders.add(key);
  return holds;
}

// Finds the Genesis Token in a wallet. Found tokens are remembered to spare the public RPC.
const knownTokens = new Map<string, { tokenAccount: string; mint: string }>();
async function findGenesisToken(owner: string) {
  if (knownTokens.has(owner)) return knownTokens.get(owner)!;
  for (const token of await heldTokens(owner, { programId: TOKEN_2022 })) {
    if (await isGenesisMint(token.mint)) return knownTokens.set(owner, token).get(owner)!;
  }
  // Dev only: lets a wallet without the token exercise the flow. ingest() also skips the check in dev.
  return DEV ? knownTokens.set(owner, { tokenAccount: owner, mint: owner }).get(owner)! : null;
}

const MAX_MESSAGE_BYTES = 640; // ponytail: one transaction's worth. Upgrade path: sign a hash shown beside the text.
const deviceAddress = (sgtMint: string) =>
  anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("device"), new anchor.web3.PublicKey(sgtMint).toBuffer()], program.programId)[0];

async function device(owner: string) {
  new anchor.web3.PublicKey(owner); // throws on a malformed address
  const token = await findGenesisToken(owner);
  if (!token) return { error: "This wallet does not hold a Seeker Genesis Token." };
  const address = deviceAddress(token.mint);
  const account = await program.account.device.fetchNullable(address);
  const hardware = account ? await program.account.hardware.fetchNullable(anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("hardware"), address.toBuffer()], program.programId)[0]) : null;
  return {
    owner,
    sgtMint: token.mint,
    proofCode: proofCode(owner),
    xLogin: Boolean(X_CONSUMER_KEY && X_CONSUMER_SECRET),
    provenHandle: signedIn.get(owner) ?? null,
    handle: account?.handle ?? null,
    approver: hardware ? Buffer.from(hardware.key).toString("hex") : null,
    hardwareEvidence: hardware ? Buffer.from(hardware.evidence).toString("hex") : null,
    destination: account ? await authorizationFor(account.handle) : null,
    compromised: account ? isCompromised(account.handle) : false,
    flagCount: account ? Number(account.flagCount) : 0,
  };
}

// ---- Sign in with X ----
// ponytail: starting a sign-in names a wallet without proving it, so a stranger could attach
// their own X account to someone's wallet here. It gains them nothing: linking still needs
// that wallet's fingerprint over a message naming the handle. State lives in memory.
const signedIn = new Map<string, string>(); // owner -> "x:handle" proven by X sign-in
const signIns = new Map<string, { owner: string; session: string }>();
const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

// "Log in with X" (OAuth 1.0a). X hands back the account name with the access token itself, so
// no paid API call is needed to learn who signed in.
const percent = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase());
function oauthHeader(url: string, extra: Record<string, string>, tokenSecret = "") {
  const fields: Record<string, string> = {
    oauth_consumer_key: X_CONSUMER_KEY!,
    oauth_nonce: base64url(crypto.getRandomValues(new Uint8Array(16))),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...extra,
  };
  const joined = Object.keys(fields).sort().map((key) => `${percent(key)}=${percent(fields[key])}`).join("&");
  const base = `POST&${percent(url)}&${percent(joined)}`;
  fields.oauth_signature = new Bun.CryptoHasher("sha1", `${percent(X_CONSUMER_SECRET!)}&${percent(tokenSecret)}`).update(base).digest("base64");
  return "OAuth " + Object.entries(fields).map(([key, value]) => `${percent(key)}="${percent(value)}"`).join(", ");
}
const oauthCall = async (url: string, extra: Record<string, string>) => {
  const response = await fetch(url, { method: "POST", headers: { authorization: oauthHeader(url, extra) } });
  const text = await response.text();
  if (!response.ok) console.error(`x sign-in: ${new URL(url).pathname} ${response.status} ${text.slice(0, 300)}`);
  return new URLSearchParams(response.ok ? text : "");
};

const signInFailed = (reason: string) =>
  typed(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Thumbprint</title>
<body style="margin:0;background:#000;color:#e7e9ea;font:16px/1.45 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh">
<main style="max-width:420px;padding:24px;text-align:center"><h1 style="font-size:22px;margin:0 0 8px">Sign-in did not finish</h1>
<p style="color:#71767b;margin:0 0 24px">${escapeHtml(reason)}</p>
<a href="/phone" style="display:block;padding:15px;border-radius:9999px;background:#14f195;color:#000;font-weight:700;text-decoration:none">Back to Thumbprint</a></main>`,
    "text/html; charset=utf-8",
  );

async function startSignIn(owner: string, session: string) {
  new anchor.web3.PublicKey(owner);
  const request = await oauthCall("https://api.x.com/oauth/request_token", { oauth_callback: `${PUBLIC_URL}/auth/x/callback` });
  const token = request.get("oauth_token");
  if (!token) return signInFailed("X did not start the sign-in. Use the post option instead.");
  signIns.set(token, { owner, session });
  setTimeout(() => signIns.delete(token), 600_000);
  return Response.redirect(`https://api.x.com/oauth/authenticate?oauth_token=${token}`, 302);
}
async function finishSignIn(token: string, verifier: string, denied: string) {
  const pending = signIns.get(token || denied);
  if (!pending) return signInFailed("This sign-in link is no longer valid. Start again from the Link screen.");
  const back = Response.redirect(`${PUBLIC_URL}/phone?session=${encodeURIComponent(pending.session)}`, 302);
  // Browsers sometimes load the callback twice; the second visit must not undo the first.
  if (signedIn.has(pending.owner)) return back;
  if (denied || !verifier) return signInFailed("X did not grant access. Start again and choose Authorize.");
  const access = await oauthCall("https://api.x.com/oauth/access_token", { oauth_token: token, oauth_verifier: verifier });
  const name = access.get("screen_name");
  if (!name) return signInFailed("X did not confirm the account. Use the post option instead.");
  signedIn.set(pending.owner, "x:" + name.toLowerCase());
  console.log(`x sign-in: confirmed a handle for ${pending.owner.slice(0, 4)}…`);
  return back;
}

const translate = (error: any) => {
  const message = error?.error?.errorMessage || error?.message || String(error);
  return new Error(/429|Too many requests/i.test(message) ? "Solana is busy right now. Try again." : message);
};

// The phone sends a message it signed; we wrap it in a transaction, pay for it and submit it.
// The program verifies the signature against the message it expects, so this server cannot
// record anything the device did not sign.
type Action = { kind: string; owner: string; handle?: string; approver?: string; proof?: string; compromised?: boolean; message: string; signature: string; ticket?: string; recipient?: string; expiresAt?: number; enabled?: boolean };
type EnrollmentChallenge = { owner: string; challenge: string; nonce: number; expires: number; handle: string };
const challenges = new Map<string, EnrollmentChallenge>();
const tickets = new Map<string, { owner: string; key: string; evidence: string; nonce: number; expires: number; message: string; signature?: string }>();
const enrollmentLimits = new Map<string, { count: number; until: number }>();
// Behind the Cloudflare tunnel every connection comes from this machine, so the visitor's address
// is the one Cloudflare reports. The origin is not reachable any other way.
const clientAddress = (request: Request, server: any) => request.headers.get("cf-connecting-ip") || server.requestIP(request)?.address || "unknown";
function limitEnrollment(ip: string) {
  const now = Date.now();
  const current = enrollmentLimits.get(ip);
  if (current && current.until > now) { if (++current.count > 10) throw new Error("Too many enrollment attempts; try again later"); }
  else enrollmentLimits.set(ip, { count: 1, until: now + 60000 });
  for (const [key, value] of enrollmentLimits) if (value.until < now) enrollmentLimits.delete(key);
  for (const [key, value] of challenges) if (value.expires < now) challenges.delete(key);
  for (const [key, value] of tickets) if (value.expires < now) tickets.delete(key);
}
async function startEnrollment(owner: string) {
  const account = await device(owner);
  if (!("handle" in account) || !account.handle) throw new Error("Link the X account with your wallet first");
  const id = crypto.randomUUID();
  const challenge = Buffer.from(new Bun.CryptoHasher("sha256").update(`${PUBLIC_URL}|${program.programId}|${owner}|${account.handle}|${account.flagCount}|${id}`).digest()).toString("base64");
  challenges.set(id, { owner, handle: account.handle, nonce: account.flagCount, challenge, expires: Date.now() + 600000 });
  return { id, challenge };
}
async function finishEnrollment(body: { id: string; certificates: unknown; signature: string }) {
  const pending = challenges.get(body.id);
  if (!pending || pending.expires < Date.now()) throw new Error("Enrollment expired; start again");
  challenges.delete(body.id); // one attempt per challenge, including failed verification
  const verified = await verifyHardware(body.certificates, pending.challenge, body.signature);
  const token = await findGenesisToken(pending.owner);
  if (!token) throw new Error("Seeker Genesis Token not found");
  const current = await program.account.device.fetch(deviceAddress(token.mint));
  if (Number(current.flagCount) !== pending.nonce || current.handle !== pending.handle) throw new Error("Account changed during enrollment; start again");
  const ticket = crypto.randomUUID();
  const message = hardwareMessage(pending.handle, verified.key, verified.evidence, pending.nonce);
  tickets.set(ticket, { owner: pending.owner, key: verified.key, evidence: verified.evidence, nonce: pending.nonce, expires: Date.now() + 600000, message });
  database.run("INSERT OR REPLACE INTO evidence VALUES (?, ?)", [verified.evidence, JSON.stringify({ ...verified, challenge: pending.challenge, certificates: body.certificates, owner: pending.owner, handle: pending.handle, checkedAt: new Date().toISOString() })]);
  return { ticket, message, ...verified };
}

async function act(body: Action) {
  if (!["bind", "hardware", "flag", "attest", "destination"].includes(body.kind)) throw new Error("Unknown action");
  if (typeof body.message !== "string" || typeof body.signature !== "string" || body.signature.length > 128) throw new Error("Invalid signature request");
  // Our verifier signature on a link is only given for a handle whose own post carries this
  // device's code. Dev mode lets the test signer link without posting.
  if (body.kind === "bind") {
    const proven = signedIn.get(body.owner) === body.handle || (DEV && !body.proof) || (await verifyProof(body.owner, String(body.proof))) === body.handle;
    if (!proven) return { error: "That post was not made by this account." };
  }
  // The whole message rides in one transaction. Refuse early, before the owner is asked to sign.
  if (Buffer.byteLength(body.message) > MAX_MESSAGE_BYTES) return { error: "This post is too long to approve." };
  const owner = new anchor.web3.PublicKey(body.owner);
  const token = await findGenesisToken(body.owner);
  if (!token) return { error: "This wallet does not hold a Seeker Genesis Token." };
  const accounts = { owner, sgtTokenAccount: new anchor.web3.PublicKey(token.tokenAccount), sgtMint: new anchor.web3.PublicKey(token.mint) };
  // Linking and moving the approval key are signed by the wallet. Posts and the kill switch are
  // signed by the approval key, which in the app only a fingerprint can use.
  const byWallet = body.kind === "bind" || body.kind === "hardware";
  const account = byWallet ? null : await program.account.device.fetchNullable(deviceAddress(token.mint));
  if (!byWallet && !account) return { error: "This Seeker is not linked to an account yet." };
  let enrollment = body.kind === "hardware" ? tickets.get(body.ticket || "") : undefined;
  if (body.kind === "hardware") {
    if (!enrollment || enrollment.owner !== body.owner || enrollment.message !== body.message || enrollment.expires < Date.now()) throw new Error("Hardware verification ticket is missing or expired");
    if (enrollment.signature) return { ok: true, signature: enrollment.signature };
  }
  const hardware = !byWallet ? await program.account.hardware.fetchNullable(anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("hardware"), deviceAddress(token.mint).toBuffer()], program.programId)[0]) : null;
  if (!byWallet && !hardware) throw new Error("Verify this phone's biometric hardware key first");
  const proof = byWallet ? anchor.web3.Ed25519Program.createInstructionWithPublicKey({ publicKey: owner.toBytes(), message: Buffer.from(body.message), signature: Buffer.from(body.signature, "base64") })
    : p256Instruction(Uint8Array.from(hardware.key), body.message, Buffer.from(body.signature, "base64"));
  if (body.kind === "destination" && (!Number.isSafeInteger(body.expiresAt) || typeof body.enabled !== "boolean")) throw new Error("Invalid destination approval");
  const method = body.kind === "bind"
    ? program.methods.bind(String(body.handle), owner).accounts({ payer: payer.publicKey, verifier: payer.publicKey, ...accounts })
    : body.kind === "hardware"
      ? program.methods.enrollHardware([...Buffer.from(enrollment!.key, "hex")], [...Buffer.from(enrollment!.evidence, "hex")]).accounts({ payer: payer.publicKey, verifier: payer.publicKey, ...accounts })
      : body.kind === "flag"
        ? program.methods.setCompromised(Boolean(body.compromised)).accounts({ payer: payer.publicKey, ...accounts })
        : body.kind === "destination"
          ? program.methods.setDestination(new anchor.web3.PublicKey(String(body.recipient)), new anchor.BN(body.expiresAt!), body.enabled).accounts({ payer: payer.publicKey, ...accounts })
          : program.methods.attest().accounts(accounts);
  // A replayed or stale signature carries a used counter: it fails simulation here and costs nothing.
  const signature = await method.preInstructions([proof]).rpc().catch((error: unknown) => Promise.reject(translate(error)));
  if (enrollment) enrollment.signature = signature;
  if (body.kind === "attest") database.run("INSERT OR REPLACE INTO post_receipts VALUES (?, ?, ?)", [signature, body.message, Buffer.from(hardware.key).toString("hex")]);
  // With a Stream configured, the record arrives through it like everyone else's.
  if (!STREAM_TOKEN) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const confirmed = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
      if (confirmed) {
        await ingest(confirmed.meta?.logMessages ?? [], signature, confirmed.blockTime ?? Math.floor(Date.now() / 1000)).catch(() => {});
        break;
      }
      await Bun.sleep(500); // the poller picks it up if this never lands
    }
  }
  return { ok: true, signature };
}

// ---- Indexer ----

const coder = new anchor.BorshCoder(idl as anchor.Idl);
const eventParser = new anchor.EventParser(new anchor.web3.PublicKey(idl.address), coder);
// The raw IDL coder keeps Rust names: events are "Bound"/"Attested", fields are snake_case.
const hex = (bytes: number[]) => Buffer.from(bytes).toString("hex");

export async function ingest(logs: string[], signature: string, blockTime: number) {
  for (const event of eventParser.parseLogs(logs)) {
    const data = event.data as any;
    if (!data.owner || !data.sgt_mint) continue; // financial state is read directly from program accounts
    const owner = data.owner.toBase58();
    const sgtMint = data.sgt_mint.toBase58();
    if (!DEV && !(await holdsGenesisToken(owner, sgtMint))) {
      console.warn(`ignored ${event.name} from ${owner}: no Seeker Genesis Token`);
      continue;
    }
    if (event.name === "Bound") saveBinding(data.handle, owner, sgtMint, blockTime);
    if (event.name === "Flagged") database.run("INSERT OR REPLACE INTO flags (handle, compromised, signature, reported_at) VALUES (?, ?, ?, ?)", [data.handle, data.compromised ? 1 : 0, signature, blockTime]);
    if (event.name === "Attested") saveAttestation(data.handle, hex(data.text_hash), owner, sgtMint, Number(data.timestamp), signature);
  }
}

// Primary data source: a QuickNode Stream (see quicknode/filter.js) pushes every transaction
// that touches the program to POST /v1/stream. Set STREAM_TOKEN to accept it.
async function ingestStream(body: { transactions?: { signature: string; blockTime?: number; logs: string[] }[] }) {
  for (const entry of body.transactions ?? []) await ingest(entry.logs, entry.signature, entry.blockTime ?? Math.floor(Date.now() / 1000));
  return { ok: true, received: body.transactions?.length ?? 0 };
}

// ponytail: fallback for local development without a Stream: polls the public RPC for program
// transactions and feeds the same ingest(). Turn off with POLL=0 once the Stream is live.
async function poll() {
  const cursor = database.query("SELECT signature FROM cursor WHERE id = 1").get() as any;
  const signatures = await rpc(PROGRAM_RPC, "getSignaturesForAddress", [idl.address, { until: cursor?.signature, limit: 100 }]);
  for (const entry of signatures.reverse()) {
    if (!entry.err) {
      const transaction = await rpc(PROGRAM_RPC, "getTransaction", [entry.signature, { maxSupportedTransactionVersion: 0 }]);
      await ingest(transaction?.meta?.logMessages ?? [], entry.signature, transaction?.blockTime ?? Math.floor(Date.now() / 1000));
    }
    database.run("INSERT INTO cursor VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET signature = excluded.signature", [entry.signature]);
  }
}
if (!STREAM_TOKEN && process.env.POLL !== "0") {
  // One pass at a time: the next starts only after the last has finished.
  const loop = () => poll().catch((error) => console.error("poll failed:", error.message)).finally(() => setTimeout(loop, 3000));
  loop();
}

// ---- Pairing relay ----

// session -> every phone page open on it. A second page joining (someone else scanning the
// pairing code) cannot push the owner's phone out; it only sees the request, and cannot sign it.
const phones = new Map<string, Set<any>>();

async function approve(body: { session: string; handle: string; text: string; hash: string }) {
  const sockets = phones.get(body.session);
  if (!sockets?.size) return { ok: false, reason: "Phone not connected" };
  if (Buffer.byteLength(attestMessage(body.handle, body.text, 999_999)) > MAX_MESSAGE_BYTES) return { ok: false, reason: "Too long to sign" };
  const key = `${body.handle}|${body.hash}`;
  let timedOut = false;
  let resolver: unknown;
  const signature = await new Promise<string | null>((resolve) => {
    waiters.set(key, resolve);
    pending.set(body.session, key);
    setTimeout(() => ((timedOut = true), resolve(null)), APPROVAL_TIMEOUT_MS);
    for (const socket of sockets) socket.send(JSON.stringify({ type: "request", handle: body.handle, text: body.text }));
    resolver = resolve;
  });
  // A retry of the same text may have replaced these; only clear our own.
  if (waiters.get(key) === resolver) waiters.delete(key);
  if (pending.get(body.session) === key) pending.delete(body.session);
  return signature ? { ok: true, signature } : { ok: false, reason: timedOut ? "Not approved in time" : "Rejected on phone" };
}

// ---- HTTP ----

// The API is public and carries no cookies, so any origin may call it.
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: CORS });
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function proofPage(signature: string) {
  const attestation = database.query("SELECT * FROM attestations WHERE signature = ?").get(signature) as any;
  if (!attestation) return new Response("No such approval", { status: 404 });
  const rows = [
    ["Account", "@" + attestation.handle.slice(2)],
    ["Approved", new Date(attestation.timestamp * 1000).toUTCString()],
    ["Device token", attestation.sgt_mint],
    ["Signed by", attestation.owner],
    ["Post fingerprint", attestation.text_hash],
  ];
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Thumbprint proof</title>
<style>body{margin:0;background:#0b0f0e;color:#e7e9ea;font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
main{max-width:560px;padding:32px 24px}h1{margin:0 0 4px;font-size:28px;color:#14f195}p{color:#aab3b0;margin:0 0 24px}
dl{margin:0;border-top:1px solid #26302d}div{padding:12px 0;border-bottom:1px solid #26302d}dt{color:#aab3b0;font-size:13px}
dd{margin:0;font-weight:600;overflow-wrap:anywhere}a{color:#14f195;font-weight:700}</style>
<main><h1>Verify this approval</h1><p id="verification">Checking the signature and exact signed text directly with Solana…</p><pre id="signed-text" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre><p>Approval key: <code id="approval-key"></code></p>
<dl>${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
<p style="margin-top:24px"><a href="https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet">View the transaction on Solana</a></p></main><script type="module" src="/proof.js"></script>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

const phoneBundle = await Bun.build({ entrypoints: [new URL("../phone/app.ts", import.meta.url).pathname], target: "browser", minify: !DEV });
if (!phoneBundle.success) throw new AggregateError(phoneBundle.logs, "phone page failed to build");
const phoneScript = await phoneBundle.outputs[0].text();
const paymentBundle = await Bun.build({ entrypoints: [new URL("../site/payment.ts", import.meta.url).pathname], target: "browser", minify: !DEV, define: { "process.env.ANCHOR_BROWSER": "true" } });
if (!paymentBundle.success) throw new AggregateError(paymentBundle.logs, "payment page failed to build");
const paymentScript = await paymentBundle.outputs[0].text();
const proofBundle = await Bun.build({ entrypoints: [new URL("../site/proof.ts", import.meta.url).pathname], target: "browser", minify: !DEV });
if (!proofBundle.success) throw new AggregateError(proofBundle.logs, "proof verification failed to build");
const proofScript = await proofBundle.outputs[0].text();

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#14f195" stroke-width="1.75" stroke-linecap="round"><rect width="24" height="24" fill="#000" stroke="none"/><path d="M4 15v-3a8 8 0 0 1 3.2-6.4"/><path d="M10.4 4.16A8 8 0 0 1 20 12v4"/><path d="M8 19v-7a4 4 0 0 1 8 0v7"/><path d="M12 12v8"/></svg>`;
// no-cache: the proxy in front of us would otherwise serve an old phone bundle for hours.
const typed = (body: string | Blob, type: string) => new Response(body, { headers: { "content-type": type, "cache-control": "no-cache", "x-content-type-options": "nosniff" } });
const guarded = (work: Promise<unknown>) => work.then((value) => json(value), (error) => json({ error: translate(error).message }, 400));

Bun.serve<{ session: string }>({
  port: PORT,
  idleTimeout: 255,
  maxRequestBodySize: 128 * 1024,
  async fetch(request, server) {
    try {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/v1/ws") {
      const session = url.searchParams.get("session");
      return session && server.upgrade(request, { data: { session } }) ? undefined : json({ error: "bad session" }, 400);
    }
    if (request.method === "POST" && url.pathname === "/v1/lookup") return guarded(request.json().then((items: any) => { if (!Array.isArray(items)) throw new Error("Expected a post list"); return Promise.all(items.slice(0, 200).map(lookup)); }));
    if (request.method === "POST" && url.pathname === "/v1/approve") return json(await approve((await request.json()) as any));
    if (url.pathname === "/phone") {
      const page = typed(Bun.file(new URL("../phone/index.html", import.meta.url)), "text/html; charset=utf-8");
      page.headers.set("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' http://localhost:* ws://localhost:* wss:; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'");
      page.headers.set("referrer-policy", "no-referrer");
      return page;
    }
    if (url.pathname === "/proof.js") return typed(proofScript, "text/javascript; charset=utf-8");
    if (url.pathname === "/payment.js") return typed(paymentScript, "text/javascript; charset=utf-8");
    if (url.pathname === "/phone.js") return typed(phoneScript, "text/javascript; charset=utf-8");
    if (url.pathname === "/thumbprint.apk") return typed(Bun.file(new URL("../site/thumbprint.apk", import.meta.url)), "application/vnd.android.package-archive");
    if (url.pathname === "/icon.svg") return typed(ICON, "image/svg+xml");
    if (url.pathname === "/v1/qr") {
      const target = `${PUBLIC_URL}/phone?session=${encodeURIComponent(url.searchParams.get("session") || "")}`;
      return typed(await QRCode.toString(target, { type: "svg", margin: 0, errorCorrectionLevel: "M" }), "image/svg+xml");
    }
    if (request.method === "POST" && url.pathname === "/v1/enrollment/challenge") return guarded((async () => { limitEnrollment(clientAddress(request, server)); return startEnrollment((await request.json() as any).owner); })());
    if (request.method === "POST" && url.pathname === "/v1/enrollment/verify") return guarded((async () => { limitEnrollment(clientAddress(request, server)); return finishEnrollment(await request.json() as any); })());
    if (url.pathname === "/v1/enrollment/ticket") {
      const ticket = tickets.get(url.searchParams.get("id") || "");
      return ticket && ticket.expires > Date.now() ? json({ owner: ticket.owner, message: ticket.message }) : json({ error: "Enrollment expired; start again" }, 400);
    }
    if (/^\/v1\/enrollment\/evidence\/[a-f0-9]{64}$/.test(url.pathname)) {
      const row = database.query("SELECT receipt FROM evidence WHERE digest = ?").get(url.pathname.split("/").pop()!) as any;
      return row ? typed(row.receipt, "application/json") : json({ error: "Evidence not found" }, 404);
    }
    if (url.pathname === "/v1/project") return guarded(authorizationFor(url.searchParams.get("handle") || ""));
    if (url.pathname === "/idl.json") return typed(JSON.stringify(idl), "application/json");
    if (url.pathname === "/pay") return typed(Bun.file(new URL("../site/pay.html", import.meta.url)), "text/html; charset=utf-8");
    if (url.pathname === "/demo") return typed(Bun.file(new URL("../site/demo.html", import.meta.url)), "text/html; charset=utf-8");
    if (url.pathname === "/demo-evidence.json") return typed(Bun.file(new URL("../site/demo-evidence.json", import.meta.url)), "application/json");
    if (url.pathname === "/v1/device") return guarded(device(url.searchParams.get("owner") || ""));
    if (request.method === "POST" && url.pathname === "/v1/stream") {
      if (!STREAM_TOKEN || url.searchParams.get("token") !== STREAM_TOKEN) return json({ error: "bad token" }, 401);
      return guarded(request.json().then((body: any) => ingestStream(body)));
    }
    if (X_CONSUMER_KEY && url.pathname === "/auth/x") return startSignIn(url.searchParams.get("owner") || "", url.searchParams.get("session") || "");
    if (X_CONSUMER_KEY && url.pathname === "/auth/x/callback") return finishSignIn(url.searchParams.get("oauth_token") || "", url.searchParams.get("oauth_verifier") || "", url.searchParams.get("denied") || "");
    if (url.pathname === "/check") return typed(Bun.file(new URL("../site/check.html", import.meta.url)), "text/html; charset=utf-8");
    if (url.pathname === "/") return typed(Bun.file(new URL("../site/index.html", import.meta.url)), "text/html; charset=utf-8");
    if (/^\/site\/[\w-]+\.png$/.test(url.pathname)) return typed(Bun.file(new URL(`..${url.pathname}`, import.meta.url)), "image/png");
    if (url.pathname.startsWith("/v1/address/")) return guarded(endorsements(url.pathname.slice(12)));
    if (url.pathname === "/v1/recent")
      return json({
        total: (database.query("SELECT COUNT(*) AS count FROM attestations").get() as any).count,
        accounts: (database.query("SELECT COUNT(*) AS count FROM bindings").get() as any).count,
        recent: database.query("SELECT handle, timestamp, signature FROM attestations WHERE signature NOT LIKE 'dev-%' ORDER BY timestamp DESC LIMIT 6").all(),
      });
    if (url.pathname === "/v1/proof")
      return guarded(verifyProof(url.searchParams.get("owner") || "", url.searchParams.get("link") || "").then((handle) => ({ handle })));
    if (request.method === "POST" && url.pathname === "/v1/act") return guarded(request.json().then((body: any) => act(body)));
    if (url.pathname === "/v1/paired") return json({ paired: Boolean(phones.get(url.searchParams.get("session") || "")?.size) });
    if (url.pathname.startsWith("/p/")) return proofPage(url.pathname.slice(3));
    // Dev preview bridge: a popup on this origin hands the extension source to the page that
    // opened it and then stands in for the background worker, so the real content script can run
    // on x.com (whose CSP blocks localhost) without loading the unpacked extension.
    if (DEV && url.pathname === "/dev/bridge") {
      const read = (name: string) => Bun.file(new URL(`../extension/${name}`, import.meta.url)).text();
      const bundle = { css: await read("content.css"), js: (await read("shared.js")) + "\n" + (await read("content.js")) };
      const page = `<title>Thumbprint dev bridge</title><script>${await read("shared.js")}
const params = new URLSearchParams(location.search);
const session = params.get("session");
// ?from=x:real&as=x:test answers for one handle with another's records, so the flow can be
// exercised on a logged-in account without linking that account to a test key.
const swap = (handle) => (handle === params.get("from") ? params.get("as") : handle);
const server = params.get("server") || ""; // ?server=https://... previews against another deployment
const post = (path, body) => fetch(server + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((response) => response.json());
opener.postMessage({ tpBundle: ${JSON.stringify(bundle).replace(/</g, "\\u003c")} }, "*");
addEventListener("message", async (event) => {
  const { tpCall, message } = event.data || {};
  if (!tpCall) return;
  let result = null;
  try {
    if (message.type === "lookup") result = await post("/v1/lookup", message.items.map((item) => ({ ...item, handle: swap(item.handle) })));
    if (message.type === "approve") result = await post("/v1/approve", { session, handle: swap(message.handle), text: message.text, hash: await sha256Hex(message.text) });
  } catch {
    result = message.type === "approve" ? { ok: false, reason: "Server unreachable" } : null;
  }
  event.source.postMessage({ tpReply: tpCall, result }, event.origin);
});
</script>Keep this window open while previewing.`;
      return typed(page, "text/html; charset=utf-8");
    }
    if (DEV && request.method === "POST" && url.pathname === "/dev/bind") {
      const body = (await request.json()) as any;
      saveBinding(body.handle, "dev", body.sgtMint || "DevDevice1111111111111111111111111111111111", body.boundAt ?? Math.floor(Date.now() / 1000));
      return json({ ok: true });
    }
    return new Response("Thumbprint", { status: url.pathname === "/" ? 200 : 404 });
    } catch (error) { return json({ error: translate(error).message }, 400); }
  },
  websocket: {
    open(socket: any) {
      phones.set(socket.data.session, (phones.get(socket.data.session) ?? new Set()).add(socket));
    },
    close(socket: any) {
      phones.get(socket.data.session)?.delete(socket);
    },
    message(socket: any, raw: string) {
      try { if (JSON.parse(raw).type === "reject") waiters.get(pending.get(socket.data.session) || "")?.(null); } catch { /* malformed socket messages cannot approve anything */ }
    },
  },
});
console.log(`Thumbprint server on ${PUBLIC_URL}${DEV ? " (dev mode: token check off, /dev/* on)" : ""}`);
