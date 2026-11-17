import { verifyPostProof } from "../lib/post-proof.ts";

const status = document.getElementById("verification")!;
const parameters = new URLSearchParams(location.search);
const signature = location.pathname.split("/").pop()!;
verifyPostProof(signature, parameters.get("handle") || "", { hash: parameters.get("hash") || undefined }).then(proof => {
  status.textContent = "Verified directly with Solana: this exact text and its complete URLs were approved by the enrolled biometric key. The approval covers a post published within 15 minutes of it.";
  document.getElementById("signed-text")!.textContent = proof.text;
  document.getElementById("approval-key")!.textContent = proof.key;
}, error => {
  status.textContent = `Verification unavailable: ${error.message}. No approval claim is made until the check succeeds.`;
});
