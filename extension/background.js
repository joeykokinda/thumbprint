// All network access for the extension. The content script only talks to this worker.
importScripts("shared.js");

const DEFAULT_SERVER = "http://localhost:8787";

async function settings() {
  const stored = await chrome.storage.local.get({ server: DEFAULT_SERVER, session: null });
  if (!stored.session) {
    stored.session = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    await chrome.storage.local.set({ session: stored.session });
  }
  return stored;
}

async function post(path, body) {
  const { server } = await settings();
  const response = await fetch(server + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const work =
    message.type === "lookup"
      ? post("/v1/lookup", message.items)
      : message.type === "approve"
        ? settings().then(async ({ session }) =>
            post("/v1/approve", { session, handle: message.handle, text: message.text, hash: await sha256Hex(message.text) })
          )
        : Promise.resolve(null);
  work.then(sendResponse, () => sendResponse(message.type === "approve" ? { ok: false, reason: "Server unreachable" } : null));
  return true; // keep the channel open for the async reply
});
