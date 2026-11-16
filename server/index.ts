// Thumbprint server: lookup API for the extension, pairing relay between laptop and phone,
// indexer for the Solana program, and proof pages. Run with: bun server/index.ts
import { Database } from "bun:sqlite";
import * as anchor from "@coral-xyz/anchor";
import QRCode from "qrcode";
import { homedir } from "node:os";
import { attestMessage } from "../phone/messages.ts";
import { proofCode, verifyProof } from "./proof.ts";
import idl from "./idl.json"; // copied from target/idl after anchor build

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const PROGRAM_RPC = process.env.PROGRAM_RPC || "https://api.devnet.solana.com";
const MAINNET_RPC = process.env.MAINNET_RPC || "https://api.mainnet-beta.solana.com";
const STREAM_TOKEN = process.env.STREAM_TOKEN; // set once the QuickNode Stream is live: it becomes the only data source
const DEV = process.env.THUMBPRINT_DEV === "1"; // enables /dev/* seeding and skips the token check
// Optional "Sign in with X" for proving handle control (OAuth 2.0 with PKCE). Without these,
// linking uses the proof post in proof.ts.
const X_CLIENT_ID = process.env.X_CLIENT_ID;
const X_CLIENT_SECRET = process.env.X_CLIENT_SECRET;
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
  CREATE TABLE IF NOT EXISTS attestations (
    handle TEXT, text_hash TEXT, owner TEXT, sgt_mint TEXT, timestamp INTEGER, signature TEXT,
    PRIMARY KEY (handle, text_hash));
  CREATE TABLE IF NOT EXISTS flags (handle TEXT PRIMARY KEY, compromised INTEGER);
  CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK (id = 1), signature TEXT);
`);

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

const isCompromised = (handle: string) =>
  Boolean((database.query("SELECT compromised FROM flags WHERE handle = ?").get(handle) as any)?.compromised);

function lookup(item: { handle: string; hash: string; postedAt?: string | null }) {
  return { ...lookupPost(item), compromised: isCompromised(item.handle) };
}

function lookupPost(item: { handle: string; hash: string; postedAt?: string | null }) {
  const attestation = database
    .query("SELECT * FROM attestations WHERE handle = ? AND text_hash = ?")
    .get(item.handle, item.hash) as any;
  if (attestation) {
    const dayAgo = Math.floor(Date.now() / 1000) - 86_400;
    const recent = database
      .query("SELECT COUNT(*) AS count FROM attestations WHERE sgt_mint = ? AND timestamp > ?")
      .get(attestation.sgt_mint, dayAgo) as any;
    return {
      state: "certified",
      timestamp: attestation.timestamp,
      sgtMint: attestation.sgt_mint,
      recentCount: recent.count,
      proofUrl: `${PUBLIC_URL}/p/${attestation.signature}`,
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
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const deviceAddress = (sgtMint: string) =>
  anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("device"), new anchor.web3.PublicKey(sgtMint).toBuffer()], program.programId)[0];

async function device(owner: string) {
  new anchor.web3.PublicKey(owner); // throws on a malformed address
  const token = await findGenesisToken(owner);
  if (!token) return { error: "This wallet does not hold a Seeker Genesis Token." };
  const account = await program.account.device.fetchNullable(deviceAddress(token.mint));
  return {
    owner,
    sgtMint: token.mint,
    proofCode: proofCode(owner),
    xLogin: Boolean(X_CLIENT_ID),
    provenHandle: signedIn.get(owner) ?? null,
    handle: account?.handle ?? null,
    compromised: account ? isCompromised(account.handle) : false,
    flagCount: account ? Number(account.flagCount) : 0,
  };
}

// ---- Sign in with X ----
// ponytail: starting a sign-in names a wallet without proving it, so a stranger could attach
// their own X account to someone's wallet here. It gains them nothing: linking still needs
// that wallet's fingerprint over a message naming the handle. State lives in memory.
const signedIn = new Map<string, string>(); // owner -> "x:handle" proven by X sign-in
const signIns = new Map<string, { owner: string; session: string; verifier: string }>();
const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

function startSignIn(owner: string, session: string) {
  new anchor.web3.PublicKey(owner);
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  signIns.set(state, { owner, session, verifier });
  setTimeout(() => signIns.delete(state), 600_000);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: X_CLIENT_ID!,
    redirect_uri: `${PUBLIC_URL}/auth/x/callback`,
    scope: "users.read tweet.read",
    state,
    code_challenge: new Bun.CryptoHasher("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  return Response.redirect(`https://x.com/i/oauth2/authorize?${query}`, 302);
}

const signInFailed = (reason: string) =>
  typed(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Thumbprint</title>
<body style="margin:0;background:#000;color:#e7e9ea;font:16px/1.45 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh">
<main style="max-width:420px;padding:24px;text-align:center"><h1 style="font-size:22px;margin:0 0 8px">Sign-in did not finish</h1>
<p style="color:#71767b;margin:0 0 24px">${escapeHtml(reason)}</p>
<a href="/phone" style="display:block;padding:15px;border-radius:9999px;background:#14f195;color:#000;font-weight:700;text-decoration:none">Back to Thumbprint</a></main>`,
    "text/html; charset=utf-8",
  );

async function finishSignIn(state: string, code: string, denied: string) {
  const pending = signIns.get(state);
  if (!pending) return signInFailed("This sign-in link is no longer valid. Start again from the Link screen.");
  const back = Response.redirect(`${PUBLIC_URL}/phone?session=${encodeURIComponent(pending.session)}`, 302);
  // Browsers sometimes load the callback twice; the second visit must not undo the first.
  if (signedIn.has(pending.owner)) return back;
  if (denied || !code) return signInFailed("X did not grant access. Start again and choose Authorize.");
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (X_CLIENT_SECRET) headers.authorization = "Basic " + Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString("base64");
  const tokenResponse = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers,
    body: new URLSearchParams({ code, grant_type: "authorization_code", client_id: X_CLIENT_ID!, redirect_uri: `${PUBLIC_URL}/auth/x/callback`, code_verifier: pending.verifier }),
  });
  const token = (await tokenResponse.json().catch(() => ({}))) as any;
  if (!token.access_token) {
    console.error(`x sign-in: token exchange ${tokenResponse.status} ${token.error ?? ""} ${token.error_description ?? ""}`);
    return signInFailed("X did not accept the sign-in. Start again from the Link screen.");
  }
  const meResponse = await fetch("https://api.x.com/2/users/me", { headers: { authorization: `Bearer ${token.access_token}` } });
  const me = (await meResponse.json().catch(() => ({}))) as any;
  if (!me?.data?.username) {
    console.error(`x sign-in: users/me ${meResponse.status} ${me.title ?? ""} ${me.detail ?? ""}`);
    return signInFailed(meResponse.status === 402 || meResponse.status === 403 || meResponse.status === 429 ? "X would not share the account name with this app. Use the post option instead." : "X did not confirm the account. Start again from the Link screen.");
  }
  signedIn.set(pending.owner, "x:" + String(me.data.username).toLowerCase());
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
async function act(body: { kind: string; owner: string; handle?: string; proof?: string; compromised?: boolean; message: string; signature: string }) {
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
  const proof = anchor.web3.Ed25519Program.createInstructionWithPublicKey({
    publicKey: owner.toBytes(),
    message: Buffer.from(body.message),
    signature: Buffer.from(body.signature, "base64"),
  });
  const method =
    body.kind === "bind"
      ? program.methods.bind(String(body.handle)).accounts({ payer: payer.publicKey, verifier: payer.publicKey, ...accounts })
      : body.kind === "flag"
        ? program.methods.setCompromised(Boolean(body.compromised)).accounts(accounts)
        : program.methods.attest().accounts(accounts);
  if (body.kind === "attest") {
    // An approval already on record costs nothing to repeat, so a copied signature cannot be
    // replayed to drain the fee payer.
    const account = await program.account.device.fetchNullable(deviceAddress(token.mint));
    const text = account && body.message.startsWith(attestMessage(account.handle, "")) ? body.message.slice(attestMessage(account.handle, "").length) : null;
    const existing = text !== null && (database.query("SELECT signature FROM attestations WHERE handle = ? AND text_hash = ?").get(account.handle, sha256(text)) as any);
    if (existing) return { ok: true, signature: existing.signature };
  }
  const signature = await method.preInstructions([proof]).rpc().catch((error: unknown) => Promise.reject(translate(error)));
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
    const owner = data.owner.toBase58();
    const sgtMint = data.sgt_mint.toBase58();
    if (!DEV && !(await holdsGenesisToken(owner, sgtMint))) {
      console.warn(`ignored ${event.name} from ${owner}: no Seeker Genesis Token`);
      continue;
    }
    if (event.name === "Bound") saveBinding(data.handle, owner, sgtMint, blockTime);
    if (event.name === "Flagged") database.run("INSERT OR REPLACE INTO flags VALUES (?, ?)", [data.handle, data.compromised ? 1 : 0]);
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
  if (Buffer.byteLength(attestMessage(body.handle, body.text)) > MAX_MESSAGE_BYTES) return { ok: false, reason: "Too long to sign" };
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
<main><h1>Approved on a real device</h1><p>A person pressed their thumb on a Solana Seeker to approve this exact post.</p>
<dl>${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
<p style="margin-top:24px"><a href="https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet">View the transaction on Solana</a></p></main>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

const phoneBundle = await Bun.build({ entrypoints: [new URL("../phone/app.ts", import.meta.url).pathname], target: "browser", minify: !DEV });
if (!phoneBundle.success) throw new AggregateError(phoneBundle.logs, "phone page failed to build");
const phoneScript = await phoneBundle.outputs[0].text();
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#14f195" stroke-width="1.75" stroke-linecap="round"><rect width="24" height="24" fill="#000" stroke="none"/><path d="M4 15v-3a8 8 0 0 1 3.2-6.4"/><path d="M10.4 4.16A8 8 0 0 1 20 12v4"/><path d="M8 19v-7a4 4 0 0 1 8 0v7"/><path d="M12 12v8"/></svg>`;
const typed = (body: string | Blob, type: string) => new Response(body, { headers: { "content-type": type } });
const guarded = (work: Promise<unknown>) => work.then((value) => json(value), (error) => json({ error: translate(error).message }, 400));

Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/v1/ws") {
      const session = url.searchParams.get("session");
      return session && server.upgrade(request, { data: { session } }) ? undefined : json({ error: "bad session" }, 400);
    }
    if (request.method === "POST" && url.pathname === "/v1/lookup") return json(((await request.json()) as any[]).slice(0, 200).map(lookup));
    if (request.method === "POST" && url.pathname === "/v1/approve") return json(await approve((await request.json()) as any));
    if (url.pathname === "/phone") return typed(Bun.file(new URL("../phone/index.html", import.meta.url)), "text/html; charset=utf-8");
    if (url.pathname === "/phone.js") return typed(phoneScript, "text/javascript; charset=utf-8");
    if (url.pathname === "/icon.svg") return typed(ICON, "image/svg+xml");
    if (url.pathname === "/v1/qr") {
      const target = `${PUBLIC_URL}/phone?session=${encodeURIComponent(url.searchParams.get("session") || "")}`;
      return typed(await QRCode.toString(target, { type: "svg", margin: 0, errorCorrectionLevel: "M" }), "image/svg+xml");
    }
    if (url.pathname === "/v1/device") return guarded(device(url.searchParams.get("owner") || ""));
    if (request.method === "POST" && url.pathname === "/v1/stream") {
      if (!STREAM_TOKEN || url.searchParams.get("token") !== STREAM_TOKEN) return json({ error: "bad token" }, 401);
      return guarded(request.json().then((body: any) => ingestStream(body)));
    }
    if (X_CLIENT_ID && url.pathname === "/auth/x") return startSignIn(url.searchParams.get("owner") || "", url.searchParams.get("session") || "");
    if (X_CLIENT_ID && url.pathname === "/auth/x/callback") return finishSignIn(url.searchParams.get("state") || "", url.searchParams.get("code") || "", url.searchParams.get("error") || "").catch(() => signInFailed("Could not reach X. Try again."));
    if (url.pathname === "/") return typed(Bun.file(new URL("../site/index.html", import.meta.url)), "text/html; charset=utf-8");
    if (/^\/site\/[\w-]+\.png$/.test(url.pathname)) return typed(Bun.file(new URL(`..${url.pathname}`, import.meta.url)), "image/png");
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
    if (DEV && request.method === "POST" && url.pathname === "/dev/attest") {
      const body = (await request.json()) as any;
      const signature = "dev-" + crypto.randomUUID();
      saveAttestation(body.handle, body.hash, "dev", body.sgtMint || "DevDevice1111111111111111111111111111111111", Math.floor(Date.now() / 1000), signature);
      return json({ ok: true, signature });
    }
    return new Response("Thumbprint", { status: url.pathname === "/" ? 200 : 404 });
  },
  websocket: {
    open(socket: any) {
      phones.set(socket.data.session, (phones.get(socket.data.session) ?? new Set()).add(socket));
    },
    close(socket: any) {
      phones.get(socket.data.session)?.delete(socket);
    },
    message(socket: any, raw: string) {
      if (JSON.parse(raw).type === "reject") waiters.get(pending.get(socket.data.session) || "")?.(null);
    },
  },
});
console.log(`Thumbprint server on ${PUBLIC_URL}${DEV ? " (dev mode: token check off, /dev/* on)" : ""}`);
