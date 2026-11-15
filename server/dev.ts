// Seeds records on a dev-mode server so the extension can be previewed without a phone.
//   bun server/dev.ts certify x:handle "exact post text"
//   bun server/dev.ts protect x:handle
import "../extension/shared.js";

const [command, handle, text] = process.argv.slice(2);
const server = process.env.SERVER || "http://localhost:8787";
const send = (path: string, body: unknown) =>
  fetch(server + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((response) => response.text());

if (command === "certify" && handle && text) {
  console.log(await send("/dev/attest", { handle, hash: await (globalThis as any).sha256Hex((globalThis as any).normalizeText(text)) }));
} else if (command === "protect" && handle) {
  console.log(await send("/dev/bind", { handle, boundAt: 0 }));
} else {
  console.log('usage: bun server/dev.ts certify x:handle "post text" | protect x:handle');
}
