import { createHash, createPublicKey, ECDH, verify } from "node:crypto";
import { fileURLToPath } from "node:url";
import { compactP256 } from "./signatures.ts";

export const enrollmentProof = (challenge: string, key: string) => `Thumbprint enrollment proof\nChallenge: ${challenge}\nKey: ${key}`;

// Google maintains certificate parsing, path validation, trust roots and revocation checks.
// This host process additionally enforces the app identity and biometric-per-use policy.
export async function verifyHardware(certificates: unknown, challenge: string, signature: string) {
  if (!Array.isArray(certificates) || certificates.length < 3 || certificates.length > 8 || certificates.some(c => typeof c !== "string" || c.length > 16000)) throw new Error("Invalid attestation certificates");
  const command = fileURLToPath(new URL("../attestation/build/upstream/build/install/keyattestation/bin/keyattestation", import.meta.url));
  const process = Bun.spawn([command], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...Bun.env, JAVA_HOME: Bun.env.JAVA_HOME || "/usr/lib/jvm/java-21-openjdk" } });
  process.stdin.write(JSON.stringify({ certificates, challenge }));
  process.stdin.end();
  const timer = setTimeout(() => process.kill(), 20_000);
  const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  clearTimeout(timer);
  if (exit !== 0) throw new Error(stderr.trim() || "Hardware verification unavailable");
  const result = JSON.parse(stdout);
  if (!result.ok || !/^(02|03)[a-f0-9]{64}$/.test(result.key)) throw new Error("Invalid verifier result");
  const key = Buffer.from(result.key, "hex");
  const uncompressed = ECDH.convertKey(key, "prime256v1", undefined, undefined, "uncompressed") as Buffer;
  const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: uncompressed.subarray(1, 33).toString("base64url"), y: uncompressed.subarray(33).toString("base64url") }, format: "jwk" });
  if (!verify("sha256", Buffer.from(enrollmentProof(challenge, result.key)), { key: publicKey, dsaEncoding: "ieee-p1363" }, compactP256(Buffer.from(signature, "base64")))) throw new Error("The attested key did not sign the enrollment proof");
  const evidence = createHash("sha256").update(JSON.stringify({ policy: "thumbprint-biometric-v2", challenge, certificates, key: result.key })).digest("hex");
  return { key: result.key as string, evidence, policy: "thumbprint-biometric-v2", securityLevel: result.securityLevel as string };
}
