import { solToLamports } from "./amount.ts";
import { Buffer } from "buffer";
import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { BorshAccountsCoder, utils } from "@coral-xyz/anchor";
import idl from "../server/idl.json";
import { PROGRAM_ID } from "../phone/messages.ts";
(globalThis as any).Buffer = Buffer;

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const program = new PublicKey(PROGRAM_ID), coder = new BorshAccountsCoder(idl as any);
const derive = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program)[0];
const field = (id: string) => document.getElementById(id)!;
const handleInput = field("handle") as HTMLInputElement;
const record = field("record"), outcome = field("outcome"), send = field("send") as HTMLButtonElement;
const escape = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const explorer = (kind: string, value: string) => `https://explorer.solana.com/${kind}/${encodeURIComponent(value)}?cluster=devnet`;
let current: Awaited<ReturnType<typeof read>> | null = null;
let submitting = false;


async function account(name: string, address: PublicKey): Promise<any> {
  const value = await connection.getAccountInfo(address);
  if (!value) return null;
  if (!value.owner.equals(program)) throw new Error("Record has an unexpected owner");
  return coder.decode(name, value.data);
}
async function read(handle: string) {
  if (!/^x:[a-z0-9_]{1,15}$/.test(handle)) throw new Error("Enter the expected project's X handle");
  const handleClaim = derive(Buffer.from("handle"), Buffer.from(handle));
  const claim = await account("HandleClaim", handleClaim);
  if (!claim) throw new Error("This project has not enrolled with Thumbprint");
  const device = derive(Buffer.from("device"), claim.sgt_mint.toBuffer());
  const hardware = derive(Buffer.from("hardware"), device.toBuffer());
  const authorization = derive(Buffer.from("treasury"), Buffer.from(handle));
  const status = derive(Buffer.from("status"), Buffer.from(handle));
  const [approved, key, suspended] = await Promise.all([account("Authorization", authorization), account("Hardware", hardware), account("Status", status)]);
  if (!approved) throw new Error("This project has not explicitly approved a payment destination");
  if (approved.handle !== handle) throw new Error("Project identity mismatch");
  const state = suspended?.compromised ? "Payments suspended" : !approved.enabled ? "Approval revoked" : !key || !approved.generation.eq(key.generation) ? "Approval needed after key replacement" : Number(approved.expires_at) <= Date.now() / 1000 ? "Approval expired" : "Approved destination";
  return { handle, handleClaim, device, hardware, authorization, status, approved, key, state, ok: state === "Approved destination" };
}
async function refresh() {
  const handle = "x:" + handleInput.value.trim().replace(/^x:|^@/g, "").toLowerCase();
  const loaded = await read(handle);
  current = loaded;
  const a = loaded.approved;
  const evidence = loaded.key ? Buffer.from(loaded.key.evidence).toString("hex") : "";
  record.innerHTML = `<section class="card"><span class="label"><i class="sq${loaded.ok ? "" : " alert"}"></i>@${escape(handle.slice(2))}</span><h2 class="${loaded.ok ? "good" : "bad"}">${loaded.state}</h2><dl><div><dt>Payment recipient</dt><dd>${a.recipient.toBase58()}</dd></div><div><dt>Approval expires</dt><dd>${escape(new Date(Number(a.expires_at) * 1000).toLocaleString())}</dd></div><div><dt>Evidence</dt><dd><a target="_blank" rel="noopener" href="${explorer("address", loaded.authorization.toBase58())}">Approval record on Solana</a>${evidence ? ` · <a target="_blank" rel="noopener" href="/v1/enrollment/evidence/${evidence}">Phone hardware attestation</a>` : ""}</dd></div></dl></section>`;
  (field("payment") as HTMLElement).hidden = !loaded.ok;
  history.replaceState(null, "", "?handle=" + encodeURIComponent(handle));
}
field("project-form").addEventListener("submit", async event => {
  event.preventDefault(); if (submitting) return;
  current = null; field("payment").hidden = true;
  record.textContent = "Reading current approval from Solana…";
  try { await refresh(); } catch (error: any) { record.textContent = error.message; }
});
field("payment-form").addEventListener("submit", async event => {
  event.preventDefault(); if (submitting || !current?.ok) return;
  submitting = true; send.disabled = true;
  let signature: string | null = null;
  try {
    const expectedHandle = current.handle;
    const expectedRecipient = current.approved.recipient.toBase58();
    const amount = solToLamports((field("amount") as HTMLInputElement).value.trim());
    const wallet = (window as any).phantom?.solana || (window as any).solana || (window as any).backpack;
    if (!wallet?.signTransaction) throw new Error("Open this page in a browser with a Solana wallet set to devnet");
    const connected = await wallet.connect();
    const payer = new PublicKey(connected.publicKey.toString());
    const fresh = await read(expectedHandle);
    if (!fresh.ok || fresh.approved.recipient.toBase58() !== expectedRecipient) throw new Error("Approval changed. Verify the destination again before paying");
    const name = Buffer.from(expectedHandle), data = Buffer.alloc(8 + 4 + name.length + 8);
    data.set(idl.instructions.find(ix => ix.name === "pay")!.discriminator);
    data.writeUInt32LE(name.length, 8); name.copy(data, 12); data.writeBigUInt64LE(amount, 12 + name.length);
    const instruction = new TransactionInstruction({ programId: program, data, keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: fresh.approved.recipient, isSigner: false, isWritable: true },
      ...[fresh.handleClaim, fresh.device, fresh.hardware, fresh.authorization, fresh.status, SystemProgram.programId].map(pubkey => ({ pubkey, isSigner: false, isWritable: false })),
    ] });
    const block = await connection.getLatestBlockhash();
    const transaction = new Transaction({ feePayer: payer, ...block }).add(instruction);
    outcome.textContent = "Review the project recipient and test SOL amount in your wallet.";
    const signed = await wallet.signTransaction(transaction);
    // Derive the signature before sending so a dropped response cannot cause a blind retry.
    signature = utils.bytes.bs58.encode(signed.signature!);
    outcome.innerHTML = `Submitting protected payment… <a href="${explorer("tx", signature)}" target="_blank" rel="noopener">Track transaction ↗</a>`;
    await connection.sendRawTransaction(signed.serialize(), { maxRetries: 2 });
    const confirmed = await connection.confirmTransaction({ signature, ...block }, "confirmed");
    if (confirmed.value.err) throw new Error("The program rejected this payment");
    outcome.innerHTML = `Payment confirmed to the approved destination. <a href="${explorer("tx", signature)}" target="_blank" rel="noopener">View transaction ↗</a>`;
  } catch (error: any) {
    outcome.textContent = signature ? "Payment outcome needs verification. Check the transaction before attempting another payment. " : error.message || "Payment cancelled";
    if (signature) {
      const link = document.createElement("a"); link.href = explorer("tx", signature); link.textContent = "Check submitted transaction ↗"; link.target = "_blank"; link.rel = "noopener"; outcome.append(link);
    }
  } finally { submitting = false; send.disabled = false; }
});
handleInput.value = new URLSearchParams(location.search).get("handle") || "";
if (handleInput.value) refresh().catch(error => { record.textContent = error.message; });
setInterval(() => { if (!submitting && current && document.visibilityState === "visible") refresh().catch(() => { current = null; field("payment").hidden = true; record.textContent = "Verification unavailable. Retry project verification."; }); }, 12000);
