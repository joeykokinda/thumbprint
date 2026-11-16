// End-to-end smoke test against a running dev server (THUMBPRINT_DEV=1): a throwaway key links a
// handle, approves a post and the lookup finds it. Run with: bun server/smoke.ts
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import * as anchor from "@coral-xyz/anchor";
import { attestMessage, bindMessage } from "../phone/messages.ts";

const SERVER = process.env.SERVER || "http://localhost:8787";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const owner = new anchor.web3.PublicKey(publicKey.export({ type: "spki", format: "der" }).subarray(-32)).toBase58();
const act = async (action: object, message: string) =>
  (await fetch(`${SERVER}/v1/act`, {
    method: "POST",
    body: JSON.stringify({ ...action, owner, message, signature: sign(null, Buffer.from(message), privateKey).toString("base64") }),
  })).json() as Promise<any>;
const expect = (label: string, condition: unknown, detail?: unknown) => {
  console.log(condition ? "ok  " : "FAIL", label, condition ? "" : JSON.stringify(detail));
  if (!condition) process.exitCode = 1;
};

const handle = "x:smoke_" + owner.slice(0, 8).toLowerCase();
const text = "smoke test post";
const stolen = await act({ kind: "bind", handle, proof: "https://x.com/jack/status/20" }, bindMessage(handle, owner));
expect("a post without the device's code does not link a handle", stolen.error, stolen);
const bound = await act({ kind: "bind", handle }, bindMessage(handle, owner));
expect("links a handle", bound.ok, bound);
const attested = await act({ kind: "attest" }, attestMessage(handle, text));
expect("records an approval", attested.ok, attested);
const replayed = await act({ kind: "attest" }, attestMessage(handle, text));
expect("a repeated approval is answered from the record, not paid for again", replayed.signature === attested.signature, replayed);
const hash = createHash("sha256").update(text).digest("hex");
const [found] = (await (await fetch(`${SERVER}/v1/lookup`, { method: "POST", body: JSON.stringify([{ handle, hash }]) })).json()) as any[];
expect("lookup finds the approved post", found.state === "certified", found);

// A post naming a Solana address records that address where any wallet can check it.
const mint = anchor.web3.Keypair.generate().publicKey.toBase58();
const announced = await act({ kind: "attest" }, attestMessage(handle, `Our only token is ${mint}`));
expect("approves a post that names an address", announced.ok, announced);
const [quoted] = (await (await fetch(`${SERVER}/v1/lookup`, { method: "POST", body: JSON.stringify([{ handle: "x:someone_else", hash: "", addresses: [mint] }]) })).json()) as any[];
expect("anyone's post naming that address shows who approved it", quoted.addresses?.[0]?.handle === handle, quoted);
const record = quoted.addresses?.[0]?.recordUrl.match(/address\/(\w+)/)?.[1];
const onchain = record && (await new anchor.web3.Connection("https://api.devnet.solana.com").getAccountInfo(new anchor.web3.PublicKey(record)));
expect("the record is an account on Solana", onchain, record);
