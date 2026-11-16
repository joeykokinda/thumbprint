// Thumbprint server: lookup API for the extension, pairing relay between laptop and phone,
// indexer for the Solana program, and proof pages. Run with: bun server/index.ts
import { Database } from "bun:sqlite";
import * as anchor from "@coral-xyz/anchor";
import QRCode from "qrcode";
import { homedir } from "node:os";
import idl from "./idl.json"; // copied from target/idl after anchor build

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const PROGRAM_RPC = process.env.PROGRAM_RPC || "https://api.devnet.solana.com";
const MAINNET_RPC = process.env.MAINNET_RPC || "https://api.mainnet-beta.solana.com";
const DEV = process.env.THUMBPRINT_DEV === "1"; // enables /dev/* seeding and skips the token check
const SGT_GROUP = "GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const APPROVAL_TIMEOUT_MS = 120_000;
// Pays fees and account rent so the phone's wallet needs no SOL. It only ever signs
// transactions made purely of this program's instructions (see submit()).
const payer = anchor.web3.Keypair.fromSecretKey(
  Uint8Array.from(await Bun.file(process.env.PAYER_KEYPAIR || `${homedir()}/.config/solana/id.json`).json()),
);
const connection = new anchor.web3.Connection(PROGRAM_RPC, "confirmed");

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

async function rpc(url: string, method: string, params: unknown[]) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
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

export async function holdsGenesisToken(owner: string, sgtMint: string): Promise<boolean> {
  return (await isGenesisMint(sgtMint)) && (await heldTokens(owner, { mint: sgtMint })).length > 0;
}

// Finds the Genesis Token in a wallet, so the phone page knows which accounts to pass.
async function findGenesisToken(owner: string) {
  for (const token of await heldTokens(owner, { programId: TOKEN_2022 })) {
    if (await isGenesisMint(token.mint)) return token;
  }
  // Dev only: lets a wallet without the token exercise the flow. ingest() also skips the check in dev.
  return DEV ? { tokenAccount: owner, mint: owner } : null;
}

async function device(owner: string) {
  new anchor.web3.PublicKey(owner); // throws on a malformed address
  const token = await findGenesisToken(owner);
  if (!token) return { error: "This wallet does not hold a Seeker Genesis Token." };
  const binding = database.query("SELECT handle FROM bindings WHERE sgt_mint = ?").get(token.mint) as any;
  return {
    owner,
    sgtMint: token.mint,
    sgtTokenAccount: token.tokenAccount,
    handle: binding?.handle ?? null,
    compromised: binding ? isCompromised(binding.handle) : false,
    payer: payer.publicKey.toBase58(),
  };
}

// The phone signed as owner; we add the fee payer signature and send. Refuses anything that
// is not purely this program, since the payer's signature would otherwise be a blank cheque.
async function submit(encoded: string) {
  const transaction = anchor.web3.Transaction.from(Buffer.from(encoded, "base64"));
  const ours = transaction.instructions.length > 0 && transaction.instructions.every((instruction) => instruction.programId.toBase58() === idl.address);
  if (!ours || !transaction.feePayer?.equals(payer.publicKey)) return { error: "Unexpected transaction" };
  transaction.partialSign(payer);
  const signature = await connection.sendRawTransaction(transaction.serialize());
  await connection.confirmTransaction(signature, "confirmed");
  const confirmed = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  await ingest(confirmed?.meta?.logMessages ?? [], signature, confirmed?.blockTime ?? Math.floor(Date.now() / 1000));
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

// ponytail: polls the public RPC for program transactions. The QuickNode Stream webhook
// replaces this as the data source and calls the same ingest(); the poller stays as a
// local-development fallback.
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
if (process.env.POLL !== "0") {
  setInterval(() => poll().catch((error) => console.error("poll failed:", error.message)), 2500);
}

// ---- Pairing relay ----

const phones = new Map<string, any>(); // session -> phone websocket

async function approve(body: { session: string; handle: string; text: string; hash: string }) {
  const phone = phones.get(body.session);
  if (!phone) return { ok: false, reason: "Phone not connected" };
  const key = `${body.handle}|${body.hash}`;
  let timedOut = false;
  const signature = await new Promise<string | null>((resolve) => {
    waiters.set(key, resolve);
    pending.set(body.session, key);
    setTimeout(() => ((timedOut = true), resolve(null)), APPROVAL_TIMEOUT_MS);
    phone.send(JSON.stringify({ type: "request", handle: body.handle, text: body.text }));
  });
  waiters.delete(key);
  pending.delete(body.session);
  return signature ? { ok: true, signature } : { ok: false, reason: timedOut ? "Not approved in time" : "Rejected on phone" };
}

// ---- HTTP ----

const json = (value: unknown, status = 200) => Response.json(value, { status });
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
const guarded = (work: Promise<unknown>) => work.then((value) => json(value), (error) => json({ error: error.message }, 400));

Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(request, server) {
    const url = new URL(request.url);
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
    if (url.pathname === "/v1/blockhash") return guarded(connection.getLatestBlockhash());
    if (request.method === "POST" && url.pathname === "/v1/submit") return guarded(request.json().then((body: any) => submit(body.transaction)));
    if (url.pathname === "/v1/paired") return json({ paired: phones.has(url.searchParams.get("session") || "") });
    if (url.pathname.startsWith("/p/")) return proofPage(url.pathname.slice(3));
    // Dev preview bridge: a popup on this origin hands the extension source to the opener,
    // so the real content script can be run on x.com without reloading the extension.
    if (DEV && url.pathname === "/dev/bridge") {
      const read = (name: string) => Bun.file(new URL(`../extension/${name}`, import.meta.url)).text();
      const bundle = { css: await read("content.css"), js: (await read("shared.js")) + "\n" + (await read("content.js")) };
      return new Response(`<script>opener.postMessage(${JSON.stringify(bundle).replace(/</g, "\\u003c")}, "*"); close();</script>`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
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
      phones.set(socket.data.session, socket);
    },
    close(socket: any) {
      if (phones.get(socket.data.session) === socket) phones.delete(socket.data.session);
    },
    message(socket: any, raw: string) {
      if (JSON.parse(raw).type === "reject") waiters.get(pending.get(socket.data.session) || "")?.(null);
    },
  },
});
console.log(`Thumbprint server on ${PUBLIC_URL}${DEV ? " (dev mode: token check off, /dev/* on)" : ""}`);
