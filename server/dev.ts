// Marks a handle as protected on a dev-mode server, so unsigned-post warnings can be previewed
// without a phone. Approved marks cannot be seeded: readers verify them against Solana.
//   bun server/dev.ts x:handle
const handle = process.argv[2];
const server = process.env.SERVER || "http://localhost:8787";
if (!handle) console.log("usage: bun server/dev.ts x:handle");
else console.log(await (await fetch(server + "/dev/bind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle, boundAt: 0 }) })).text());
export {};
