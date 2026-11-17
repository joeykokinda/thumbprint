import { expect, test } from "bun:test";
import { ECDH, generateKeyPairSync, sign, verify } from "node:crypto";
import { compactP256, p256Instruction } from "./signatures.ts";

test("Android DER signatures become valid low-S Solana P-256 proofs", () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const message = "Approve treasury payment to Alice";
  const signature = sign("sha256", Buffer.from(message), pair.privateKey);
  const compact = compactP256(signature);
  expect(compact.length).toBe(64);
  expect(verify("sha256", Buffer.from(message), { key: pair.publicKey, dsaEncoding: "ieee-p1363" }, compact)).toBe(true);
  expect(verify("sha256", Buffer.from("Pay attacker"), { key: pair.publicKey, dsaEncoding: "ieee-p1363" }, compact)).toBe(false);
  const jwk = pair.publicKey.export({ format: "jwk" });
  const uncompressed = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  const key = ECDH.convertKey(uncompressed, "prime256v1", undefined, undefined, "compressed") as Buffer;
  const instruction = p256Instruction(key, message, signature);
  expect(instruction.data.subarray(16, 49)).toEqual(key);
  expect(instruction.data.subarray(49, 113)).toEqual(compact);
  expect(instruction.data.subarray(113).toString()).toBe(message);
  expect(() => compactP256(Buffer.alloc(64))).toThrow();
  expect(() => compactP256(Buffer.from([48, 3, 2, 1, 1]))).toThrow();
});
