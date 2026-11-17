// Records real devnet transactions for the public walkthrough. Only the dedicated demo
// buyer spends funds; failed scenarios are submitted so their rejection is inspectable.
import * as anchor from "@coral-xyz/anchor";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import idl from "./idl.json";

const handle = process.argv[2] || "x:spekthumbprint";
const scenario = process.argv[3] || "approved";
if (!/^(approved|substitution|suspended|revoked)$/.test(scenario)) throw new Error("Scenario must be approved, substitution, suspended, or revoked");
if (!/^x:[a-z0-9_]{1,15}$/.test(handle)) throw new Error("Invalid project handle");
const rpc = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
const sponsor = anchor.web3.Keypair.fromSecretKey(Uint8Array.from(await Bun.file(process.env.PAYER_KEYPAIR || `${homedir()}/.config/solana/id.json`).json()));
const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(rpc, new anchor.Wallet(sponsor), { commitment: "confirmed" })) as any;
const authorization = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("treasury"), Buffer.from(handle)], program.programId)[0];
const approved = await program.account.authorization.fetchNullable(authorization);
if (!approved) throw new Error("Approve a treasury destination on the Seeker before recording payment evidence");
await mkdir(".anchor", { recursive: true });
const walletPath = ".anchor/demo-buyer.json";
if (!(await Bun.file(walletPath).exists())) await Bun.write(walletPath, JSON.stringify([...anchor.web3.Keypair.generate().secretKey]), { mode: 0o600 });
const buyer = anchor.web3.Keypair.fromSecretKey(Uint8Array.from(await Bun.file(walletPath).json()));
let balance = await rpc.getBalance(buyer.publicKey);
if (balance < 950_000) {
  const topup = 1_000_000 - balance; // 0.001 SOL covers rent plus several tiny demonstrations
  await anchor.web3.sendAndConfirmTransaction(rpc, new anchor.web3.Transaction().add(anchor.web3.SystemProgram.transfer({ fromPubkey: sponsor.publicKey, toPubkey: buyer.publicKey, lamports: topup })), [sponsor]);
  balance += topup;
}
const recipient = scenario === "substitution" ? anchor.web3.Keypair.generate().publicKey : approved.recipient;
const before = await rpc.getBalance(recipient);
const instruction = await program.methods.pay(handle, new anchor.BN(1000)).accounts({ payer: buyer.publicKey, recipient }).instruction();
const block = await rpc.getLatestBlockhash();
const transaction = new anchor.web3.Transaction({ feePayer: buyer.publicKey, ...block }).add(instruction);
transaction.sign(buyer);
const signature = await rpc.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 2 });
const result = await rpc.confirmTransaction({ signature, ...block }, "confirmed");
const receipt = await rpc.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
const after = await rpc.getBalance(recipient);
const logs = receipt?.meta?.logMessages || [];
const reason = logs.join(" ").match(/Error Code: (\w+)/)?.[1] || null;
const expectedError = { substitution: "WrongRecipient", suspended: "ReportedCompromised", revoked: "Revoked" }[scenario];
if (scenario === "approved" ? Boolean(result.value.err) || after - before !== 1000 : !result.value.err || reason !== expectedError || after !== before) throw new Error(`Unexpected ${scenario} outcome; inspect ${signature}: ${reason}`);
const path = "site/demo-evidence.json";
const evidence = await Bun.file(path).exists() ? await Bun.file(path).json() : { network: "devnet", program: program.programId.toBase58(), handle, scenarios: {} };
if (evidence.handle !== handle || evidence.program !== program.programId.toBase58()) throw new Error("Existing demo evidence belongs to another project");
evidence.scenarios[scenario] = { signature, recipient: recipient.toBase58(), payer: buyer.publicKey.toBase58(), lamports: 1000, recipientChange: after - before, fee: receipt?.meta?.fee, rejected: Boolean(result.value.err), reason, recordedAt: new Date().toISOString() };
await Bun.write(path, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({ scenario, signature, recipientChange: after - before, reason, fee: receipt?.meta?.fee, explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet` }));
