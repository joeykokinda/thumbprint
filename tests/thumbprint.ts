import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { createHash, createPrivateKey, sign, generateKeyPairSync } from "node:crypto";
import type { Thumbprint } from "../target/types/thumbprint";
import { attestMessage, bindMessage, flagMessage, hardwareMessage, destinationMessage, domain } from "../phone/messages.ts";

import { p256Instruction } from "../server/signatures.ts";

type PublicKey = anchor.web3.PublicKey;
const { Keypair, PublicKey, Ed25519Program } = anchor.web3;
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

// What the Seed Vault does on the phone: an Ed25519 signature over the readable message.
function deviceSignature(keypair: anchor.web3.Keypair, message: string) {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), keypair.secretKey.subarray(0, 32)]);
  const signature = sign(null, Buffer.from(message), createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }));
  return Ed25519Program.createInstructionWithPublicKey({ publicKey: keypair.publicKey.toBytes(), message: Buffer.from(message), signature });
}

describe("thumbprint", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.thumbprint as Program<Thumbprint>;
  const owner = Keypair.fromSecretKey(Uint8Array.from(fixture("owner.json")));
  const verifier = Keypair.fromSecretKey(Uint8Array.from(fixture("verifier.json")));
  const sgtMint = new PublicKey("5mXbkqKz883aufhAsx3p5Z1NcvD2ppZbdTTznM6oUKLj");
  const sgtTokenAccount = new PublicKey(fixture("sgt_token_account.json").pubkey);
  const handle = "x:tester";
  const accounts = { owner: owner.publicKey, sgtTokenAccount, sgtMint };
  const derive = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const device = derive(Buffer.from("device"), sgtMint.toBuffer());
  const hardware = derive(Buffer.from("hardware"), device.toBuffer());
  const authorization = derive(Buffer.from("treasury"), Buffer.from(handle));
  const status = derive(Buffer.from("status"), Buffer.from(handle));
  const handleClaim = derive(Buffer.from("handle"), Buffer.from(handle));
  let thumb = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const compressed = () => {
    const jwk = thumb.publicKey.export({ format: "jwk" });
    const y = Buffer.from(jwk.y!, "base64url");
    return Buffer.concat([Buffer.from([2 + (y[31] & 1)]), Buffer.from(jwk.x!, "base64url")]);
  };
  const signed = (message: string) => p256Instruction(compressed(), message, sign("sha256", Buffer.from(message), thumb.privateKey));
  const count = async () => Number((await program.account.device.fetch(device)).flagCount);
  const reject = async (work: Promise<unknown>, code?: string) => {
    const error: any = await work.then(() => null, e => e);
    assert.ok(error, "unexpected success");
    if (code) assert.equal(error?.error?.errorCode?.code, code, String(error));
  };
  const evidence = Buffer.alloc(32, 7); // trusted verifier policy is tested separately offchain
  const enroll = async (signer = verifier, nonce?: number) => program.methods
    .enrollHardware([...compressed()], [...evidence])
    .accountsPartial({ payer: provider.wallet.publicKey, verifier: signer.publicKey, ...accounts })
    .preInstructions([deviceSignature(owner, hardwareMessage(handle, compressed().toString("hex"), evidence.toString("hex"), nonce ?? await count(), "localnet"))])
    .signers([signer]).rpc();
  const setDestination = async (recipient: PublicKey, expiry: number, enabled = true, nonce?: number, messageHandle = handle, network = "localnet", sign = signed) => program.methods
    .setDestination(recipient, new anchor.BN(expiry), enabled)
    .accountsPartial({ payer: provider.wallet.publicKey, ...accounts })
    .preInstructions([sign(destinationMessage(messageHandle, recipient.toBase58(), expiry, enabled, nonce ?? await count(), network))]).rpc();
  const pay = (recipient: PublicKey, amount = 1_000_000) => program.methods.pay(handle, new anchor.BN(amount))
    .accountsPartial({ payer: provider.wallet.publicKey, recipient, handleClaim, device, hardware, authorization, status }).rpc();
  const expiry = () => Math.floor(Date.now() / 1000) + 3600;
  const recipient = Keypair.generate().publicKey;

  before(async () => { while ((await provider.connection.getSlot()) < 3) await new Promise(r => setTimeout(r, 200)); });

  it("binds only with handle verification and a Genesis Token holder", async () => {
    const bind = (key: anchor.web3.Keypair) => program.methods.bind(handle, owner.publicKey)
      .accountsPartial({ payer: provider.wallet.publicKey, verifier: key.publicKey, ...accounts })
      .preInstructions([deviceSignature(owner, bindMessage(handle, owner.publicKey.toBase58()))]).signers([key]).rpc();
    await reject(bind(Keypair.generate()), "NotVerified");
    const impostor = Keypair.generate();
    await reject(program.methods.bind(handle, impostor.publicKey)
      .accountsPartial({ payer: provider.wallet.publicKey, verifier: verifier.publicKey, ...accounts, owner: impostor.publicKey })
      .preInstructions([deviceSignature(impostor, bindMessage(handle, impostor.publicKey.toBase58()))]).signers([verifier]).rpc(), "NotSeeker");
    await bind(verifier);
    await reject(program.methods.attest().accountsPartial({ ...accounts, hardware }).preInstructions([deviceSignature(owner, attestMessage(handle, "text", 0, "localnet"))]).rpc());
  });

  it("requires verifier approval for hardware enrollment and prevents replay", async () => {
    await reject(enroll(Keypair.generate()), "NotVerified");
    await enroll();
    await reject(enroll(verifier, 0), "WrongMessage");
    assert.deepEqual((await program.account.hardware.fetch(hardware)).key, [...compressed()]);
  });

  it("verifies P-256 post signatures and rejects wallet/PIN or modified content", async () => {
    const text = "Claim at https://example.com/legit?to=alice";
    const attest = (proof: anchor.web3.TransactionInstruction) => program.methods.attest().accountsPartial(accounts).preInstructions([proof]).rpc();
    const approval = signed(attestMessage(handle, text, await count(), "localnet"));
    await attest(approval);
    // The captured signature cannot be submitted again to make an old approval look fresh.
    await reject(attest(approval), "WrongMessage");
    await reject(attest(deviceSignature(owner, attestMessage(handle, text, await count(), "localnet"))), "NotSigned");
    await reject(attest(signed(attestMessage("x:attacker", text, await count(), "localnet"))), "WrongMessage");
    await reject(attest(signed(attestMessage(handle, text, await count(), "devnet"))), "WrongMessage");
    const altered = signed(attestMessage(handle, text, await count(), "localnet")); altered.data[altered.data.length - 1] ^= 1;
    await reject(attest(altered));
    await attest(signed(attestMessage(handle, text, await count(), "localnet"))); // approving the same words again takes a new signature
  });

  it("never authorizes an address by mentioning it in a signed warning", async () => {
    const warning = `Do not buy ${recipient}; this is a scam.`;
    await program.methods.attest().accountsPartial(accounts).preInstructions([signed(attestMessage(handle, warning, await count(), "localnet"))]).rpc();
    assert.equal(await program.account.authorization.fetchNullable(authorization), null);
    await reject(pay(recipient));
  });

  it("enforces explicit recipient, expiry bounds, counter, handle and deployment", async () => {
    await reject(setDestination(recipient, 1), "InvalidExpiry");
    await reject(setDestination(recipient, expiry() + 8 * 86400), "InvalidExpiry");
    await reject(setDestination(recipient, expiry(), true, undefined, "x:attacker"), "WrongMessage");
    await reject(setDestination(recipient, expiry(), true, undefined, handle, "devnet"), "WrongMessage");
    const nonce = await count(), expires = expiry();
    await setDestination(recipient, expires, true, nonce);
    await reject(setDestination(recipient, expires, true, nonce), "WrongMessage");
    const state = await program.account.authorization.fetch(authorization);
    assert.equal(state.recipient.toBase58(), recipient.toBase58());
  });

  it("transfers to the authorized recipient, rejects an actual recipient substitution", async () => {
    const before = await provider.connection.getBalance(recipient);
    await pay(recipient);
    assert.equal(await provider.connection.getBalance(recipient), before + 1_000_000);
    const attacker = Keypair.generate().publicKey;
    await reject(pay(attacker), "WrongRecipient");
    assert.equal(await provider.connection.getBalance(attacker), 0);
    await reject(pay(recipient, 0), "InvalidAmount");
  });

  it("checks suspension at execution, then allows recovery", async () => {
    const flag = async (compromised: boolean) => {
      const message = `${domain("localnet")}\nReport ${handle} as ${compromised ? "compromised" : "recovered"} (#${await count()})`;
      return program.methods.setCompromised(compromised).accountsPartial({ payer: provider.wallet.publicKey, ...accounts }).preInstructions([signed(message)]).rpc();
    };
    await flag(true);
    await reject(pay(recipient), "ReportedCompromised");
    await flag(false);
    await pay(recipient);
  });

  it("revokes and replaces destinations without resurrecting old approvals", async () => {
    await setDestination(recipient, expiry(), false);
    await reject(pay(recipient), "Revoked");
    const replacement = Keypair.generate().publicKey;
    await setDestination(replacement, expiry());
    await reject(pay(recipient), "WrongRecipient");
    await pay(replacement);
  });

  it("expires approvals at execution", async () => {
    await setDestination(recipient, Math.floor(Date.now() / 1000) + 3);
    await new Promise(r => setTimeout(r, 4500));
    await reject(pay(recipient), "Expired");
  });

  it("rotation needs the verifier and invalidates earlier payment authorization", async () => {
    await setDestination(recipient, expiry());
    thumb = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    await reject(enroll(Keypair.generate()), "NotVerified");
    await enroll();
    await reject(pay(recipient), "KeyChanged");
    await setDestination(recipient, expiry());
    await pay(recipient);
    // The wallet alone, which may accept a PIN, can no longer approve anything.
    await reject(setDestination(recipient, expiry(), true, undefined, handle, "localnet", (message) => deviceSignature(owner, message)), "NotSigned");
  });
});
