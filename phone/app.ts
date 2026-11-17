// Thumbprint phone page. It builds every signed message itself from the text it shows, so the
// laptop can never get the owner to sign something they did not read.
//
// It runs in two places on the Seeker:
// - inside the Thumbprint app, where posts are approved by a key in the phone's secure hardware
//   that only a fingerprint can use (the app exposes it as `ThumbprintKey`);
// - in Chrome, once, where the Seed Vault wallet (through Mobile Wallet Adapter) proves this is
//   a real Seeker and hands approval to that fingerprint key. The wallet may take a PIN, which
//   is why it is not what approves posts.
import { transact } from "@solana-mobile/mobile-wallet-adapter-protocol-web3js";
import { PublicKey } from "@solana/web3.js";
import "../extension/shared.js"; // normalizeText: the one rule that turns a post into the text that is signed
import { attestMessage, bindMessage, flagMessage, destinationMessage } from "./messages.ts";

type Device = { owner: string; sgtMint: string; proofCode: string; xLogin: boolean; provenHandle: string | null; handle: string | null; approver: string | null; compromised: boolean; flagCount: number; hardwareEvidence?: string; destination?: { state: string; recipient?: string; expiresAt?: number } };
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
  // The wallet is reached over a socket on this phone, and Chrome asks permission for that the
  // first time. Ask before the wallet opens: its sheet would otherwise sit on top of Chrome's
  // prompt and swallow the tap. The probe itself always fails; only the prompt matters.
  await fetch("http://localhost:9/", { mode: "no-cors" }).catch(() => {});
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

// The app's fingerprint key. `sign` shows the system fingerprint prompt with the message on it.
const NATIVE = (window as any).ThumbprintKey as { publicKey(): string; enroll(challenge: string): void; sign(message: string): void; openBrowser(url: string): void; xResult(id: string, result: string): void } | undefined;
let nativeKey = NATIVE?.publicKey() || "";
// In Chrome: the app's key, which this page is here to link with the wallet.
const linkingFor = query.get("setup") || query.get("enrollment") || "";
const appLink = (parameters: string) => `intent://phone?${parameters}#Intent;scheme=thumbprint;package=org.pyras.thumbprint;end`;

let fingerprintDone: ((result: { signature: string; error: string }) => void) | null = null;
(window as any).thumbprintSigned = (signature: string, error: string) => {
  const done = fingerprintDone;
  fingerprintDone = null;
  done?.({ signature, error });
};
const fingerprint = (message?: string) =>
  new Promise<Signed>((resolve, reject) => {
    if (fingerprintDone) return reject(new Error("Finish or cancel the current approval first."));
    fingerprintDone = (result) => (result.error ? reject(new Error(result.error)) : resolve({ owner: state.device!.owner, signature: fromBase64(result.signature) }));
    NATIVE!.sign(message!);
  });

const signer = SOFTWARE ? software : NATIVE ? fingerprint : seedVault;

async function refreshDevice(owner = state.device?.owner) {
  if (!owner) return;
  state.device = await api(`/v1/device?owner=${owner}`);
  localStorage.setItem("device", JSON.stringify(state.device));
}

// One prompt per action. The server pays for and submits the transaction; the
// program checks this signature onchain, so the server cannot act without it.
async function signAndSubmit(action: object, message: string) {
  const signed = await signer(message);
  if (signed.owner !== state.device!.owner) throw new Error("The wallet changed. Reconnect your Seeker.");
  return api("/v1/act", { ...action, owner: signed.owner, message, signature: base64(signed.signature) });
}

async function approvePost(text: string) {
  await refreshDevice(); // the signed message carries the current counter, which makes it single use
  await signAndSubmit({ kind: "attest" }, attestMessage(state.device!.handle!, text, state.device!.flagCount));
}

// ---- Actions ----

async function run(label: string, action: () => Promise<void>) {
  if (state.busy) return;
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
    run("Opening wallet", async () => {
      // The account is whoever published the proof post; the test signer types a handle instead.
      const handle = proof
        ? (await api(`/v1/proof?owner=${state.device!.owner}&link=${encodeURIComponent(proof)}`)).handle
        : "x:" + fields.get("handle")!.toString().trim().replace(/^@/, "").toLowerCase();
      const approver = state.device!.owner; // the test signer approves with its own key
      await signAndSubmit({ kind: "bind", handle, proof, approver }, bindMessage(handle, approver));
      await refreshDevice();
    });
  },
  prepareHardware: () => run("Verifying this phone", async () => {
    const pending = await api("/v1/enrollment/challenge", { owner: state.device!.owner });
    const attested = await new Promise<any>((resolve, reject) => {
      (window as any).thumbprintEnrolled = (output: string, error: string) => error ? reject(new Error(error)) : resolve(JSON.parse(output));
      NATIVE!.enroll(pending.challenge);
    });
    nativeKey = attested.key;
    const proof = await fingerprint(`Thumbprint enrollment proof\nChallenge: ${pending.challenge}\nKey: ${nativeKey}`);
    const checked = await api("/v1/enrollment/verify", { id: pending.id, certificates: attested.certificates, signature: base64(proof.signature) });
    NATIVE!.openBrowser(`${location.origin}/phone?enrollment=${encodeURIComponent(checked.ticket)}&owner=${encodeURIComponent(state.device!.owner)}&session=${encodeURIComponent(session)}`);
  }),
  completeHardware: () => run("Confirming verified key", async () => {
    const ticket = query.get("enrollment")!;
    const enrollment = await api(`/v1/enrollment/ticket?id=${encodeURIComponent(ticket)}`);
    await refreshDevice(enrollment.owner);
    await signAndSubmit({ kind: "hardware", ticket }, enrollment.message);
    (state as any).enrolled = true;
    await refreshDevice();
  }),
  openLink: () => NATIVE!.openBrowser(`${location.origin}/phone?setup=1&session=${encodeURIComponent(session)}`),
  destination: (form) => run("Approving treasury destination", async () => {
    await refreshDevice();
    const fields = new FormData(form!);
    const recipient = new PublicKey(fields.get("recipient")!.toString().trim()).toBase58();
    // Ten minutes under the choice, so a phone clock running fast cannot exceed the program's seven-day bound.
    const expiresAt = Math.floor(Date.now() / 1000) + (fields.get("days") === "7" ? 7 : 1) * 86400 - 600;
    await signAndSubmit({ kind: "destination", recipient, expiresAt, enabled: true }, destinationMessage(state.device!.handle!, recipient, expiresAt, true, state.device!.flagCount));
    await refreshDevice();
  }),
  revokeDestination: () => run("Revoking treasury destination", async () => {
    await refreshDevice();
    const d = state.device!;
    const recipient = d.destination!.recipient!, expiresAt = d.destination!.expiresAt!;
    await signAndSubmit({ kind: "destination", recipient, expiresAt, enabled: false }, destinationMessage(d.handle!, recipient, expiresAt, false, d.flagCount));
    await refreshDevice();
  }),
  approve: () =>
    run("Waiting for your fingerprint", async () => {
      const request = state.request!;
      await approvePost(request.text);
      state.lastSigned = request.text;
      state.request = null;
      setTimeout(() => ((state.lastSigned = ""), render()), 4000);
    }),
  // Posting from this phone: approve what was typed, then hand the same words to X's composer.
  compose: (form) => {
    const draft = new FormData(form!).get("text")!.toString().trim();
    run("Waiting for your fingerprint", async () => {
      await approvePost((globalThis as any).normalizeText(draft));
      location.href = `https://x.com/intent/post?text=${encodeURIComponent(draft)}`;
    });
  },
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

// The X tab in the app asks here for approval of a draft. X never sees the key, and the handle
// is the one this phone is linked to, whatever the page claims.
(window as any).approveForX = async (id: string, text: string) => {
  let result: object = { ok: true };
  try {
    if (!state.device?.handle || state.device.approver !== nativeKey) throw new Error("Link this Seeker first, in the Thumbprint tab");
    await approvePost(text);
  } catch (error: any) {
    result = { ok: false, reason: error?.message || String(error) };
  }
  NATIVE!.xResult(id, JSON.stringify(result));
};

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
  if (NATIVE && !device?.handle)
    return `<section class="hero"><div class="glyph">${GLYPH}</div><h1>Protect your account</h1>
      <p>First connect your Seeker wallet and prove control of your X account. Then verify this phone's biometric key.</p></section>
      <button class="primary" data-action="openLink">Connect and link account</button>`;
  if (NATIVE && (!nativeKey || device?.approver !== nativeKey))
    return `<section class="hero"><div class="glyph">${GLYPH}</div><h1>Verify this phone</h1>
      <p>Create a hardware-protected key, prove it requires a biometric for each approval, then confirm it with your wallet. Existing payment approvals are invalidated when you replace a key.</p></section>
      <button class="primary" data-action="prepareHardware">Verify biometric hardware</button>`;
  if (!NATIVE && !SOFTWARE && !linkingFor)
    return `<section class="hero"><div class="glyph">${GLYPH}</div><h1>Open the Thumbprint app</h1>
      <p>Posts are approved in the app, with your fingerprint.</p></section>
      <a class="button primary" href="${appLink(`session=${encodeURIComponent(session)}`)}">Open Thumbprint</a>
      <a class="button quiet" href="/thumbprint.apk">Get the app</a>`;
  if (!device)
    return `<section class="hero"><div class="glyph">${GLYPH}</div><h1>Thumbprint</h1>
      <p>Approve every post with your fingerprint. If someone takes over your account, their posts show up as not signed.</p></section>
      <button class="primary" data-action="connect">Connect Seeker</button>`;

  if (!device.handle && device.provenHandle)
    return `<section class="hero"><div class="glyph">${GLYPH}</div><h1>Link ${escapeHtml("@" + device.provenHandle.slice(2))}</h1>
      <p>X confirmed this is your account. One Seeker protects one account. It cannot be changed later.</p></section>
      <form data-action="link"><input type="hidden" name="handle" value="${escapeHtml(device.provenHandle.slice(2))}">
      <button class="primary">Link with wallet</button></form>
      <a class="button quiet" href="/auth/x?owner=${device.owner}&session=${encodeURIComponent(session)}">Use a different account</a>`;

  if (!device.handle && !SOFTWARE) {
    const proofText = `Protecting this account with Thumbprint. Posts I approve are signed by my Seeker. ${device.proofCode}`;
    const byPost = `<p>Post this from the X account you want to protect. It proves the account is yours.</p>
      <blockquote>${escapeHtml(proofText)}</blockquote>
      <a class="button quiet" target="_blank" rel="noopener" href="https://x.com/intent/post?text=${encodeURIComponent(proofText)}">Post on X</a>
      <form data-action="link"><label for="proof">Link to that post</label>
      <div class="field"><input id="proof" name="proof" type="url" required inputmode="url" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="https://x.com/you/status/…"></div>
      <button class="primary">Link with wallet</button></form>`;
    if (device.xLogin)
      return `<section class="hero"><div class="glyph">${GLYPH}</div><h1>Link your account</h1>
        <p>Sign in to the X account you want to protect. Thumbprint only reads your handle.</p></section>
        <a class="button primary" href="/auth/x?owner=${device.owner}&session=${encodeURIComponent(session)}">Sign in with X</a>
        <details><summary>Prove it with a post instead</summary>${byPost}</details>`;
    return `<section><h1>Link your account</h1>
      <p>Post this from the X account you want to protect. It proves the account is yours.</p>
      <blockquote>${escapeHtml(proofText)}</blockquote>
      <a class="button quiet" target="_blank" rel="noopener" href="https://x.com/intent/post?text=${encodeURIComponent(proofText)}">Post on X</a></section>
      <form data-action="link"><label for="proof">Link to that post</label>
      <div class="field"><input id="proof" name="proof" type="url" required inputmode="url" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="https://x.com/you/status/…"></div>
      <button class="primary">Link with wallet</button></form>
      <p class="hint">One Seeker protects one account. It cannot be changed later.</p>`;
  }

  if (!device.handle)
    return `<section class="hero"><div class="glyph">${GLYPH}</div><h1>Link your account</h1>
      <p>This Seeker can protect one X account. It cannot be changed later.</p></section>
      <form data-action="link"><label for="handle">X handle</label>
      <div class="field"><span>@</span><input id="handle" name="handle" required pattern="@?[A-Za-z0-9_]{1,15}" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="yourhandle"></div>
      <button class="primary">Link with wallet</button></form>
      <dl><div><dt>Device</dt><dd>Seeker ${short(device.sgtMint)}</dd></div><div><dt>Wallet</dt><dd>${short(device.owner)}</dd></div></dl>`;

  const name = "@" + device.handle.slice(2);
  if (query.get("enrollment") && !device.approver)
    return `<section class="hero"><h1>Confirm verified biometric key</h1><p>The server checked this key's hardware attestation. Your wallet now authorizes it to protect this account.</p></section>
      <button class="primary" data-action="completeHardware">Confirm with Seeker wallet</button>`;
  if (query.get("enrollment") && !(state as any).enrolled)
    return `<section class="hero"><h1>Confirm biometric key</h1><p>Use the wallet to confirm this phone's verified key. Replacing a key invalidates existing payment approvals.</p></section>
      <button class="primary" data-action="completeHardware">Confirm with Seeker wallet</button>`;
  if (linkingFor)
    return `<section class="hero"><div class="glyph">${GLYPH}</div><h1>${escapeHtml(name)} is linked</h1>
      <p>Continue in the app to approve posts and payment destinations.</p></section>
      <a class="button primary" href="${appLink(`owner=${device.owner}&session=${encodeURIComponent(session)}`)}">Back to Thumbprint</a>`;
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
      <p>${state.lastSigned ? "Signed. Your post is going out." : NATIVE ? "Write a post here or on your computer. It goes out only with your fingerprint." : state.online ? "Posts you write on your computer appear here for approval." : session ? "Reconnecting to your computer…" : "Scan the code in the Thumbprint extension to pair this phone."}</p></section>
      ${NATIVE ? `<form data-action="compose"><textarea name="text" required rows="4" maxlength="280" placeholder="Write a post"></textarea>
      <button class="primary">Approve and post</button></form>` : ""}
      <dl><div><dt>Device</dt><dd>Seeker ${short(device.sgtMint)}</dd></div><div><dt>Wallet</dt><dd>${short(device.owner)}</dd></div>
      <div><dt>Computer</dt><dd>${state.online ? "Paired" : "Not connected"}</dd></div></dl>
      ${NATIVE ? `<section class="payment-panel"><p class="eyebrow">Protected treasury payments · devnet</p>
      <p>${device.destination?.recipient ? `Current destination: <code>${escapeHtml(device.destination.recipient)}</code> · ${escapeHtml(device.destination.state)}` : "No payment destination approved yet."}</p>
      <form data-action="destination"><label for="recipient">Treasury SOL address</label><input id="recipient" name="recipient" required placeholder="Full Solana recipient address" autocomplete="off" spellcheck="false">
      <label for="days">Approval lasts</label><select id="days" name="days"><option value="1">24 hours</option><option value="7">7 days</option></select>
      <p class="hint">Read the full address on the next screen. You can revoke at any time.</p><button class="primary">Approve destination</button></form>
      ${device.destination?.recipient ? `<a class="button quiet" href="/pay?handle=${encodeURIComponent(device.handle)}" target="_blank" rel="noopener">Open protected payment page</a><button class="quiet danger" data-action="revokeDestination">Revoke destination</button>` : ""}</section>` : ""}
      <button class="quiet danger" data-action="askKill">Suspend account and payments</button>`;
}

function render() {
  const main = document.querySelector("main")!;
  if (state.busy) {
    main.setAttribute("aria-busy", "true");
    main.querySelectorAll("button").forEach(button => button.disabled = true);
    let status = document.getElementById("busy-status");
    if (!status) { status = document.createElement("div"); status.id = "busy-status"; status.className = "busy-status"; status.setAttribute("role", "status"); document.body.append(status); }
    status.textContent = state.busy;
    return;
  }
  document.getElementById("busy-status")?.remove();
  main.removeAttribute("aria-busy");
  const values = new Map(Array.from(main.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input[name],textarea[name],select[name]")).map(input => [input.name, input.value]));
  const scroll = window.scrollY;
  main.innerHTML = body() + (state.error ? `<p class="error" role="alert">${escapeHtml(state.error)}</p>` : "") + (SOFTWARE ? `<p class="badge">Test signer. No Seeker, no fingerprint.</p>` : "");
  main.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input[name],textarea[name],select[name]").forEach(input => { if (values.has(input.name)) input.value = values.get(input.name)!; });
  window.scrollTo(0, scroll);
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
refreshDevice(query.get("owner") || undefined).then(render, () => {});
