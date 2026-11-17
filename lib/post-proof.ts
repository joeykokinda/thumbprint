import { decode } from "@coral-xyz/anchor/dist/esm/utils/bytes/bs58.js";
import { PROGRAM_ID, domain } from "../phone/messages.ts";
import idl from "../server/idl.json";

const P256 = "Secp256r1SigVerify1111111111111111111111111";
const tag = idl.instructions.find(instruction => instruction.name === "attest")!.discriminator;
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");

// Readers validate the transaction with Solana directly; a forged indexer response is insufficient.
async function transactionFromSolana(signature: string) {
  const response = await fetch("https://api.devnet.solana.com", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }] }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error("Solana proof lookup unavailable");
  const body = await response.json();
  return body.result;
}
// An approval covers a post published shortly after it. Each approval is single use onchain, so
// an identical repost outside this window needs a new fingerprint. The earlier bound absorbs
// clock difference between Solana and X.
export const APPROVAL_WINDOW_SECONDS = 900, CLOCK_SKEW_SECONDS = 120;
export function publishedWithinApproval(approvedAt: number, postedAt: string | null | undefined) {
  const posted = Date.parse(postedAt || "") / 1000;
  return posted >= approvedAt - CLOCK_SKEW_SECONDS && posted <= approvedAt + APPROVAL_WINDOW_SECONDS;
}

// Pass `postedAt` (even null) to also require that the post was published inside the approval's window.
export async function verifyPostProof(signature: string, handle: string, expected: { hash?: string; postedAt?: string | null } = {}, loadTransaction = transactionFromSolana) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature) || !/^x:[a-z0-9_]{1,15}$/.test(handle)) throw new Error("Invalid proof reference");
  const tx = await loadTransaction(signature);
  if (!tx || tx.meta?.err) throw new Error("No confirmed successful approval transaction");
  const instructions = tx.transaction.message.instructions;
  for (let i = 1; i < instructions.length; i++) {
    const instruction = instructions[i], proof = instructions[i - 1];
    if (instruction.programId !== PROGRAM_ID || proof.programId !== P256 || !instruction.data || !proof.data) continue;
    const call = decode(instruction.data);
    if (call.length !== 8 || !tag.every((value, index) => call[index] === value)) continue;
    const bytes = decode(proof.data), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 16 || bytes[0] !== 1 || [4, 8, 14].some(offset => view.getUint16(offset, true) !== 65535)) continue;
    const keyOffset = view.getUint16(6, true), offset = view.getUint16(10, true), size = view.getUint16(12, true);
    if (keyOffset + 33 > bytes.length || offset + size > bytes.length) continue;
    const message = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, offset + size));
    const prefix = `${domain()}\nApprove post as ${handle} (#`;
    const counter = message.startsWith(prefix) ? message.slice(prefix.length).match(/^(\d+)\)\n\n/) : null;
    if (!counter) continue;
    const text = message.slice(prefix.length + counter[0].length);
    const hash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
    if (expected.hash && expected.hash !== hash) continue;
    if ("postedAt" in expected && !publishedWithinApproval(tx.blockTime, expected.postedAt)) throw new Error("This approval was not given for this publication");
    return { signature, handle, text, hash, key: hex(bytes.subarray(keyOffset, keyOffset + 33)), timestamp: tx.blockTime, sgtMint: instruction.accounts[2] };
  }
  throw new Error("This transaction does not approve the exact requested text with a registered biometric key");
}
