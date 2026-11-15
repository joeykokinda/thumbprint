// Thumbprint server: lookup API for the extension, pairing relay between laptop and phone,
// indexer for the Solana program, and proof pages. Run with: bun server/index.ts
import { Database } from "bun:sqlite";
import * as anchor from "@coral-xyz/anchor";
import idl from "./idl.json"; // copied from target/idl after anchor build

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const PROGRAM_RPC = process.env.PROGRAM_RPC || "https://api.devnet.solana.com";
const MAINNET_RPC = process.env.MAINNET_RPC || "https://api.mainnet-beta.solana.com";
const DEV = process.env.THUMBPRINT_DEV === "1"; // enables /dev/* seeding and skips the token check
const SGT_GROUP = "GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const APPROVAL_TIMEOUT_MS = 120_000;

const database = new Database(process.env.DATABASE || "thumbprint.sqlite");
database.exec(`
  CREATE TABLE IF NOT EXISTS bindings (handle TEXT PRIMARY KEY, owner TEXT, sgt_mint TEXT, bound_at INTEGER);
  CREATE TABLE IF NOT EXISTS attestations (
    handle TEXT, text_hash TEXT, owner TEXT, sgt_mint TEXT, timestamp INTEGER, signature TEXT,
    PRIMARY KEY (handle, text_hash));
  CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK (id = 1), signature TEXT);
`);

// ---- Records ----

const waiters = new Map<string, (signature: string) => void>(); // "handle|hash" -> resolve

function saveBinding(handle: string, owner: string, sgtMint: string, boundAt: number) {
  database.run("INSERT OR IGNORE INTO bindings VALUES (?, ?, ?, ?)", [handle, owner, sgtMint, boundAt]);
}

function saveAttestation(handle: string, textHash: string, owner: string, sgtMint: string, timestamp: number, signature: string) {
  database.run("INSERT OR IGNORE INTO attestations VALUES (?, ?, ?, ?, ?, ?)", [handle, textHash, owner, sgtMint, timestamp, signature]);
  waiters.get(`${handle}|${textHash}`)?.(signature);
}

function lookup(item: { handle: string; hash: string; postedAt?: string | null }) {
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

export async function holdsGenesisToken(owner: string, sgtMint: string): Promise<boolean> {
  const mint = await rpc(MAINNET_RPC, "getAccountInfo", [sgtMint, { encoding: "jsonParsed" }]);
  const extensions = mint?.value?.data?.parsed?.info?.extensions ?? [];
  const member = extensions.find((extension: any) => extension.extension === "tokenGroupMember")?.state;
  if (mint?.value?.owner !== TOKEN_2022 || member?.group !== SGT_GROUP || member?.mint !== sgtMint) return false;
  const accounts = await rpc(MAINNET_RPC, "getTokenAccountsByOwner", [owner, { mint: sgtMint }, { encoding: "jsonParsed" }]);
  return accounts.value.some((account: any) => account.account.data.parsed.info.tokenAmount.amount === "1");
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
  const signature = await new Promise<string | null>((resolve) => {
    waiters.set(key, resolve);
    setTimeout(() => resolve(null), APPROVAL_TIMEOUT_MS);
    phone.send(JSON.stringify({ type: "request", handle: body.handle, text: body.text }));
  });
  waiters.delete(key);
  return signature ? { ok: true, signature } : { ok: false, reason: "Not approved in time" };
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
    if (url.pathname === "/v1/paired") return json({ paired: phones.has(url.searchParams.get("session") || "") });
    if (url.pathname.startsWith("/p/")) return proofPage(url.pathname.slice(3));
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
    message() {},
  },
});
console.log(`Thumbprint server on ${PUBLIC_URL}${DEV ? " (dev mode: token check off, /dev/* on)" : ""}`);
