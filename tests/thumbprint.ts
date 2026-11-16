import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { createHash, createPrivateKey, sign } from "node:crypto";
import type { Thumbprint } from "../target/types/thumbprint";
import { attestMessage, bindMessage, flagMessage } from "../phone/messages.ts";

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
  const sgtMint = new PublicKey("5mXbkqKz883aufhAsx3p5Z1NcvD2ppZbdTTznM6oUKLj");
  const sgtTokenAccount = new PublicKey(fixture("sgt_token_account.json").pubkey);
  const handle = "x:tester";
  const text = "hello from a real thumb";
  const accounts = { owner: owner.publicKey, sgtTokenAccount, sgtMint };
  const events = async (signature: string) => {
    await provider.connection.confirmTransaction(signature, "confirmed");
    const transaction = await provider.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    return [...new anchor.EventParser(program.programId, program.coder).parseLogs(transaction.meta.logMessages)];
  };
  const rejects = async (work: Promise<unknown>, code: string) => {
    const error: any = await work.then(() => null, (thrown) => thrown);
    assert.equal(error?.error?.errorCode?.code, code);
  };

  // A program loaded at genesis is not callable until the validator has moved past its first slots.
  before(async () => {
    while ((await provider.connection.getSlot()) < 3) await new Promise((resolve) => setTimeout(resolve, 200));
  });

  it("binds a handle and records a post the device signed", async () => {
    await program.methods
      .bind(handle)
      .accounts({ payer: provider.wallet.publicKey, ...accounts })
      .preInstructions([deviceSignature(owner, bindMessage(handle))])
      .rpc();

    const signature = await program.methods.attest().accounts(accounts).preInstructions([deviceSignature(owner, attestMessage(handle, text))]).rpc();
    const [event] = await events(signature);
    assert.equal(event.name, "attested");
    assert.equal(event.data.handle, handle);
    assert.deepEqual(Array.from(event.data.textHash), Array.from(createHash("sha256").update(text).digest()));
    assert.equal(event.data.sgtMint.toBase58(), sgtMint.toBase58());
  });

  it("rejects an action with no device signature, or one signed for another account", async () => {
    await rejects(program.methods.attest().accounts(accounts).rpc(), "NotSigned");
    const wrongHandle = deviceSignature(owner, attestMessage("x:someoneelse", text));
    await rejects(program.methods.attest().accounts(accounts).preInstructions([wrongHandle]).rpc(), "WrongMessage");
  });

  it("rejects a signer who does not hold the token", async () => {
    const impostor = Keypair.generate();
    const signed = deviceSignature(impostor, attestMessage(handle, text));
    await rejects(program.methods.attest().accounts({ ...accounts, owner: impostor.publicKey }).preInstructions([signed]).rpc(), "NotSeeker");
  });

  it("flags the account as compromised, and refuses a replayed signature", async () => {
    const report = deviceSignature(owner, flagMessage(handle, true, 0));
    const [event] = await events(await program.methods.setCompromised(true).accounts(accounts).preInstructions([report]).rpc());
    assert.equal(event.name, "flagged");
    assert.equal(event.data.compromised, true);
    await rejects(program.methods.setCompromised(true).accounts(accounts).preInstructions([report]).rpc(), "WrongMessage");
  });

  it("rejects a second handle for the same device", async () => {
    const error = await program.methods
      .bind("x:second")
      .accounts({ payer: provider.wallet.publicKey, ...accounts })
      .preInstructions([deviceSignature(owner, bindMessage("x:second"))])
      .rpc()
      .then(() => null, (thrown) => thrown);
    assert.ok(error, "second bind was accepted");
  });
});
