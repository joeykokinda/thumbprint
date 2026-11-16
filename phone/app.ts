// Thumbprint phone page. Runs in Chrome on the Seeker and talks to the Seed Vault wallet
// through Mobile Wallet Adapter. It hashes the post text itself and builds the transaction
// itself, so the laptop can never get it to sign something the owner did not read.
import { transact } from "@solana-mobile/mobile-wallet-adapter-protocol-web3js";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { Buffer } from "buffer";
import idl from "../server/idl.json";
import "../extension/shared.js"; // sha256Hex
(globalThis as any).Buffer ??= Buffer; // web3.js expects the Node global

declare const sha256Hex: (text: string) => Promise<string>;

type Device = { owner: string; sgtMint: string; sgtTokenAccount: string; handle: string | null; compromised: boolean; payer: string };
type PostRequest = { handle: string; text: string };

const PROGRAM_ID = new PublicKey(idl.address);
const IDENTITY = { name: "Thumbprint", uri: location.origin, icon: "/icon.svg" };
const session = new URLSearchParams(location.search).get("session") || localStorage.getItem("session") || "";
if (session) localStorage.setItem("session", session);

const state = {
  device: JSON.parse(localStorage.getItem("device") || "null") as Device | null,
  request: null as PostRequest | null,
  busy: "",
  error: "",
  confirmingKill: false,
  lastSigned: "",
  online: false,
};

// ---- Building instructions by hand: three instructions do not justify shipping Anchor to the phone ----

const discriminator = (name: string) => Uint8Array.from(idl.instructions.find((instruction) => instruction.name === name)!.discriminator);
const bytes = (...parts: Uint8Array[]) => {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
};
const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((pair) => parseInt(pair, 16)));
const pda = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const text = (value: string) => new TextEncoder().encode(value);
const meta = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });

function deviceAccounts(device: Device) {
  const owner = new PublicKey(device.owner);
  const sgtMint = new PublicKey(device.sgtMint);
  return { owner, sgtMint, sgtTokenAccount: new PublicKey(device.sgtTokenAccount), devicePda: pda(text("device"), sgtMint.toBytes()) };
}

function ownerInstruction(device: Device, name: "attest" | "set_compromised", data: Uint8Array) {
  const accounts = deviceAccounts(device);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [meta(accounts.owner, true), meta(accounts.sgtTokenAccount), meta(accounts.sgtMint), meta(accounts.devicePda)],
    data: Buffer.from(bytes(discriminator(name), data)),
  });
}

function bindInstruction(device: Device, handle: string) {
  const accounts = deviceAccounts(device);
  const handleBytes = text(handle);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, handleBytes.length, true);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      meta(new PublicKey(device.payer), true, true),
      meta(accounts.owner, true),
      meta(accounts.sgtTokenAccount),
      meta(accounts.sgtMint),
      meta(accounts.devicePda, false, true),
      meta(pda(text("handle"), handleBytes), false, true),
      meta(SystemProgram.programId),
    ],
    data: Buffer.from(bytes(discriminator("bind"), length, handleBytes)),
  });
}

// ---- Wallet ----

const api = async (path: string, body?: unknown) => {
  const response = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error || `Server returned ${response.status}`);
  return result;
};

async function authorize(wallet: any) {
  const result = await wallet.authorize({ chain: "solana:devnet", identity: IDENTITY, auth_token: localStorage.getItem("authToken") || undefined });
  localStorage.setItem("authToken", result.auth_token);
  const address = Uint8Array.from(atob(result.accounts[0].address), (char) => char.charCodeAt(0));
  return new PublicKey(address).toBase58();
}

async function connect() {
  const owner = await transact((wallet) => authorize(wallet));
  await refreshDevice(owner);
}

async function refreshDevice(owner = state.device?.owner) {
  if (!owner) return;
  state.device = await api(`/v1/device?owner=${owner}`);
  localStorage.setItem("device", JSON.stringify(state.device));
}

// One wallet session, one fingerprint: the Seed Vault signs, the server pays the fee and submits.
async function signAndSubmit(build: (device: Device) => TransactionInstruction) {
  const device = state.device!;
  const { blockhash } = await api("/v1/blockhash");
  const transaction = new Transaction({ feePayer: new PublicKey(device.payer), recentBlockhash: blockhash }).add(build(device));
  const signed = await transact(async (wallet) => {
    const owner = await authorize(wallet);
    if (owner !== device.owner) throw new Error("The wallet changed. Reconnect your Seeker.");
    return (await wallet.signTransactions({ transactions: [transaction] }))[0];
  });
  const serialized = signed.serialize({ requireAllSignatures: false });
  return api("/v1/submit", { transaction: btoa(String.fromCharCode(...serialized)) });
}

// ---- Actions ----

async function run(label: string, action: () => Promise<void>) {
  state.busy = label;
  state.error = "";
  render();
  try {
    await action();
  } catch (error: any) {
    state.error = error?.message || String(error);
  }
  state.busy = "";
  render();
}

const actions: Record<string, (form?: HTMLFormElement) => void> = {
  connect: () => run("Opening wallet", connect),
  link: (form) => {
    const handle = "x:" + new FormData(form!).get("handle")!.toString().trim().replace(/^@/, "").toLowerCase();
    run("Linking", async () => {
      await signAndSubmit((device) => bindInstruction(device, handle));
      await refreshDevice();
    });
  },
  approve: () =>
    run("Waiting for your fingerprint", async () => {
      const request = state.request!;
      const hash = await sha256Hex(request.text);
      await signAndSubmit((device) => ownerInstruction(device, "attest", hexToBytes(hash)));
      state.lastSigned = request.text;
      state.request = null;
    }),
  reject: () => {
    socket?.send(JSON.stringify({ type: "reject" }));
    state.request = null;
    render();
  },
  askKill: () => {
    state.confirmingKill = true;
    render();
  },
  cancelKill: () => {
    state.confirmingKill = false;
    render();
  },
  kill: () => setCompromised(true),
  recover: () => setCompromised(false),
  disconnect: () => {
    localStorage.removeItem("device");
    localStorage.removeItem("authToken");
    state.device = null;
    render();
  },
};

function setCompromised(compromised: boolean) {
  run("Waiting for your fingerprint", async () => {
    await signAndSubmit((device) => ownerInstruction(device, "set_compromised", Uint8Array.of(compromised ? 1 : 0)));
    state.confirmingKill = false;
    await refreshDevice();
  });
}

// ---- Relay ----

let socket: WebSocket | null = null;
function listen() {
  if (!session || (socket && socket.readyState <= WebSocket.OPEN)) return;
  socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/v1/ws?session=${session}`);
  socket.onopen = socket.onclose = () => {
    state.online = socket?.readyState === WebSocket.OPEN;
    render();
    if (!state.online) setTimeout(listen, 1500);
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "request") return;
    state.request = { handle: message.handle, text: message.text };
    state.error = "";
    state.lastSigned = "";
    navigator.vibrate?.(80);
    render();
  };
}
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && listen());

// ---- View ----

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const short = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;
const GLYPH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M4 15v-3a8 8 0 0 1 3.2-6.4"/><path d="M10.4 4.16A8 8 0 0 1 20 12v4"/><path d="M8 19v-7a4 4 0 0 1 8 0v7"/><path d="M12 12v8"/></svg>`;

function body(): string {
  const device = state.device;
  if (!device)
    return `<section class="hero"><div class="glyph">${GLYPH}</div><h1>Thumbprint</h1>
      <p>Approve every post with your fingerprint. If someone takes over your account, their posts show up as not signed.</p></section>
      <button class="primary" data-action="connect">Connect Seeker</button>`;

  if (!device.handle)
    return `<section class="hero"><div class="glyph">${GLYPH}</div><h1>Link your account</h1>
      <p>This Seeker can protect one X account. It cannot be changed later.</p></section>
      <form data-action="link"><label for="handle">X handle</label>
      <div class="field"><span>@</span><input id="handle" name="handle" required pattern="@?[A-Za-z0-9_]{1,15}" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="yourhandle"></div>
      <button class="primary">Link with fingerprint</button></form>
      <dl><div><dt>Device</dt><dd>Seeker ${short(device.sgtMint)}</dd></div><div><dt>Wallet</dt><dd>${short(device.owner)}</dd></div></dl>`;

  const name = "@" + device.handle.slice(2);
  if (state.request) {
    const mismatch = state.request.handle !== device.handle;
    return `<section><p class="eyebrow">Post as ${escapeHtml("@" + state.request.handle.slice(2))}</p>
      <blockquote>${escapeHtml(state.request.text)}</blockquote>
      <p class="hint">Read every word. This exact text is what your fingerprint approves.</p></section>
      ${mismatch ? `<p class="error">This Seeker protects ${escapeHtml(name)}, not that account.</p>` : `<button class="primary" data-action="approve">Approve with fingerprint</button>`}
      <button class="quiet" data-action="reject">Reject</button>`;
  }

  if (device.compromised)
    return `<section class="hero danger"><div class="glyph">${GLYPH}</div><h1>${escapeHtml(name)} is marked compromised</h1>
      <p>Everyone using Thumbprint sees a warning on this account and its links are blocked.</p></section>
      <button class="primary" data-action="recover">I have my account back</button>`;

  if (state.confirmingKill)
    return `<section class="hero danger"><div class="glyph">${GLYPH}</div><h1>Report ${escapeHtml(name)} as compromised?</h1>
      <p>Every reader sees a warning on the account right away, even while someone else controls it. You can undo this from this phone.</p></section>
      <button class="primary danger" data-action="kill">Yes, warn everyone</button>
      <button class="quiet" data-action="cancelKill">Cancel</button>`;

  return `<section class="hero"><div class="glyph">${GLYPH}</div><h1>Protecting ${escapeHtml(name)}</h1>
      <p>${state.lastSigned ? "Signed. Your post is going out." : state.online ? "Posts you write on your computer appear here for approval." : session ? "Reconnecting to your computer…" : "Scan the code in the Thumbprint extension to pair this phone."}</p></section>
      <dl><div><dt>Device</dt><dd>Seeker ${short(device.sgtMint)}</dd></div><div><dt>Wallet</dt><dd>${short(device.owner)}</dd></div>
      <div><dt>Computer</dt><dd>${state.online ? "Paired" : "Not connected"}</dd></div></dl>
      <button class="quiet danger" data-action="askKill">My account was hacked</button>`;
}

function render() {
  const main = document.querySelector("main")!;
  main.innerHTML = state.busy
    ? `<section class="hero"><div class="glyph pulse">${GLYPH}</div><h1>${state.busy}</h1><p>Double-tap the side button, then use your fingerprint.</p></section>`
    : body() + (state.error ? `<p class="error" role="alert">${escapeHtml(state.error)}</p>` : "");
}

document.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("button[data-action]");
  if (button) actions[button.dataset.action!]();
});
document.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  actions[form.dataset.action!](form);
});

render();
listen();
refreshDevice().then(render, () => {});
