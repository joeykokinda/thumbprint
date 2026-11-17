import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { encode } from "@coral-xyz/anchor/dist/esm/utils/bytes/bs58.js";
import { p256Instruction } from "../server/signatures.ts";
import { verifyPostProof } from "./post-proof.ts";
import { PROGRAM_ID, attestMessage } from "../phone/messages.ts";
import idl from "../server/idl.json";

test("reader proof binds successful program execution to the exact handle, text and URL", async () => {
  const handle = "x:project", text = "Claim at https://example.com/legit?recipient=alice";
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const key = Buffer.concat([Buffer.from([2 + (Buffer.from(jwk.y!, "base64url")[31] & 1)]), Buffer.from(jwk.x!, "base64url")]);
  const message = attestMessage(handle, text, 4);
  const proof = p256Instruction(key, message, sign("sha256", Buffer.from(message), pair.privateKey));
  const signature = encode(Buffer.alloc(64, 7));
  const instruction = { programId: PROGRAM_ID, data: encode(Buffer.from(idl.instructions.find(ix => ix.name === "attest")!.discriminator)), accounts: ["owner", "token", "mint"] };
  const tx = { blockTime: 1_800_000_000, meta: { err: null }, transaction: { message: { instructions: [{ programId: proof.programId.toBase58(), data: encode(proof.data) }, instruction] } } };
  const hash = createHash("sha256").update(text).digest("hex");
  const at = (seconds: number) => new Date((1_800_000_000 + seconds) * 1000).toISOString();
  const result = await verifyPostProof(signature, handle, { hash, postedAt: at(30) }, async () => tx);
  // The same approved text published again later, or with no publication time, earns no mark.
  await expect(verifyPostProof(signature, handle, { hash, postedAt: at(3600) }, async () => tx)).rejects.toThrow("publication");
  await expect(verifyPostProof(signature, handle, { hash, postedAt: at(-3600) }, async () => tx)).rejects.toThrow("publication");
  await expect(verifyPostProof(signature, handle, { hash, postedAt: null }, async () => tx)).rejects.toThrow("publication");
  // A message without the single-use counter is not an approval.
  const uncounted = message.replace(" (#4)", ""), old = p256Instruction(key, uncounted, sign("sha256", Buffer.from(uncounted), pair.privateKey));
  await expect(verifyPostProof(signature, handle, { hash }, async () => ({ ...tx, transaction: { message: { instructions: [{ programId: old.programId.toBase58(), data: encode(old.data) }, instruction] } } }))).rejects.toThrow();
  expect(result.text).toBe(text);
  expect(result.key).toBe(key.toString("hex"));
  expect(result.sgtMint).toBe("mint");
  await expect(verifyPostProof(signature, handle, { hash: createHash("sha256").update(text.replace("legit", "drainer")).digest("hex") }, async () => tx)).rejects.toThrow();
  await expect(verifyPostProof(signature, "x:attacker", { hash }, async () => tx)).rejects.toThrow();
  await expect(verifyPostProof(signature, handle, { hash }, async () => ({ ...tx, meta: { err: "rejected" } }))).rejects.toThrow();
  const foreign = structuredClone(tx); foreign.transaction.message.instructions[1].programId = "ForeignProgram";
  await expect(verifyPostProof(signature, handle, { hash }, async () => foreign)).rejects.toThrow();
  const legacy = structuredClone(tx); legacy.transaction.message.instructions[0].programId = "Ed25519SigVerify111111111111111111111111111";
  await expect(verifyPostProof(signature, handle, { hash }, async () => legacy)).rejects.toThrow();
});
