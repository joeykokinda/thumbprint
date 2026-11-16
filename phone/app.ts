// Thumbprint phone page. Runs in Chrome on the Seeker and asks the Seed Vault wallet, through
// Mobile Wallet Adapter, to sign a readable message. It builds that message itself from the text
// it shows, so the laptop can never get the owner to sign something they did not read.
import { transact } from "@solana-mobile/mobile-wallet-adapter-protocol-web3js";
import { PublicKey } from "@solana/web3.js";
import { attestMessage, bindMessage, flagMessage } from "./messages.ts";

type Device = { owner: string; sgtMint: string; proofCode: string; handle: string | null; compromised: boolean; flagCount: number };
type PostRequest = { handle: string; text: string };
type Signed = { owner: string; signature: Uint8Array };

const IDENTITY = { name: "Thumbprint", uri: location.origin, icon: "/icon.svg" };
const query = new URLSearchParams(location.search);
const session = query.get("session") || localStorage.getItem("session") || "";
if (session) localStorage.setItem("session", session);
// Test signer: a key held by this page instead of the Seed Vault, so the flow can be exercised
// without a fingerprint. The server only accepts it when it runs in dev mode.
const SOFTWARE = query.get("signer") === "software";

const state = {
  device: JSON.parse(localStorage.getItem("device") || "null") as Device | null,
  request: null as PostRequest | null,
  busy: "",
  error: "",
  confirmingKill: false,
  lastSigned: "",
  online: false,
};

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (encoded: string) => Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));

const api = async (path: string, body?: unknown) => {
  const response = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error || `Server returned ${response.status}`);
  return result;
};

// ---- Signers: both return the signer's address and, when given a message, its signature ----

async function seedVault(message?: string): Promise<Signed> {
  return transact(async (wallet) => {
    const authorization = await wallet.authorize({ chain: "solana:mainnet", identity: IDENTITY, auth_token: localStorage.getItem("authToken") || undefined });
    localStorage.setItem("authToken", authorization.auth_token);
    const address = authorization.accounts[0].address;
    const owner = new PublicKey(fromBase64(address)).toBase58();
    if (!message) return { owner, signature: new Uint8Array() };
    const [signed] = await wallet.signMessages({ addresses: [address], payloads: [new TextEncoder().encode(message)] });
    return { owner, signature: signed.slice(-64) }; // wallets return the message followed by the signature
  });
}

async function software(message?: string): Promise<Signed> {
  const algorithm = { name: "Ed25519" };
  let stored = localStorage.getItem("softwareKey");
  if (!stored) {
    const pair = (await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"])) as CryptoKeyPair;
    stored = JSON.stringify({
      secret: base64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
      address: new PublicKey(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))).toBase58(),
    });
    localStorage.setItem("softwareKey", stored);
  }
  const { secret, address } = JSON.parse(stored);
  if (!message) return { owner: address, signature: new Uint8Array() };
  const key = await crypto.subtle.importKey("pkcs8", fromBase64(secret), algorithm, false, ["sign"]);
  return { owner: address, signature: new Uint8Array(await crypto.subtle.sign(algorithm, key, new TextEncoder().encode(message))) };
}

const signer = SOFTWARE ? software : seedVault;

async function refreshDevice(owner = state.device?.owner) {
  if (!owner) return;
  state.device = await api(`/v1/device?owner=${owner}`);
  localStorage.setItem("device", JSON.stringify(state.device));
}

// One wallet prompt, one fingerprint. The server pays for and submits the transaction; the
// program checks this signature onchain, so the server cannot act without it.
async function signAndSubmit(action: object, message: string) {
  const signed = await signer(message);
  if (signed.owner !== state.device!.owner) throw new Error("The wallet changed. Reconnect your Seeker.");
  return api("/v1/act", { ...action, owner: signed.owner, message, signature: base64(signed.signature) });
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
  connect: () => run("Opening wallet", async () => refreshDevice((await signer()).owner)),
  link: (form) => {
    const fields = new FormData(form!);
    const proof = fields.get("proof")?.toString().trim();
    run("Linking", async () => {
      // The account is whoever published the proof post; the test signer types a handle instead.
      const handle = proof
        ? (await api(`/v1/proof?owner=${state.device!.owner}&link=${encodeURIComponent(proof)}`)).handle
        : "x:" + fields.get("handle")!.toString().trim().replace(/^@/, "").toLowerCase();
      await signAndSubmit({ kind: "bind", handle, proof }, bindMessage(handle));
      await refreshDevice();
    });
  },
  approve: () =>
    run("Waiting for your fingerprint", async () => {
      const request = state.request!;
      await signAndSubmit({ kind: "attest" }, attestMessage(state.device!.handle!, request.text));
      state.lastSigned = request.text;
      state.request = null;
      setTimeout(() => ((state.lastSigned = ""), render()), 4000);
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
    localStorage.removeItem("softwareKey");
    state.device = null;
    render();
  },
};

function setCompromised(compromised: boolean) {
  run("Waiting for your fingerprint", async () => {
    await refreshDevice(); // the signed message carries the current counter
    const device = state.device!;
    await signAndSubmit({ kind: "flag", compromised }, flagMessage(device.handle!, compromised, device.flagCount));
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

  if (!device.handle && !SOFTWARE) {
    const proofText = `Protecting this account with Thumbprint. Posts I approve are signed by my Seeker. ${device.proofCode}`;
    return `<section><h1>Link your account</h1>
      <p>Post this from the X account you want to protect. It proves the account is yours.</p>
      <blockquote>${escapeHtml(proofText)}</blockquote>
      <a class="button quiet" target="_blank" rel="noopener" href="https://x.com/intent/post?text=${encodeURIComponent(proofText)}">Post on X</a></section>
      <form data-action="link"><label for="proof">Link to that post</label>
      <div class="field"><input id="proof" name="proof" type="url" required inputmode="url" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="https://x.com/you/status/…"></div>
      <button class="primary">Link with fingerprint</button></form>
      <p class="hint">One Seeker protects one account. It cannot be changed later.</p>`;
  }

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
    ? `<section class="hero"><div class="glyph pulse">${GLYPH}</div><h1>${state.busy}</h1><p>${SOFTWARE ? "Signing with the test key." : "Double-tap the side button, then use your fingerprint."}</p></section>`
    : body() + (state.error ? `<p class="error" role="alert">${escapeHtml(state.error)}</p>` : "") + (SOFTWARE ? `<p class="badge">Test signer. No Seeker, no fingerprint.</p>` : "");
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
