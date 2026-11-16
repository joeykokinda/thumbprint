import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { createHash, createPrivateKey, sign } from "node:crypto";
import type { Thumbprint } from "../target/types/thumbprint";
import { approverMessage, attestMessage, bindMessage, flagMessage } from "../phone/messages.ts";

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
  // Stands in for the key the app keeps in the phone's secure hardware, unlocked by a fingerprint.
  let thumb = Keypair.generate();
  const verifier = Keypair.fromSecretKey(Uint8Array.from(fixture("verifier.json")));
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
    const bind = (signer: anchor.web3.Keypair) =>
      program.methods
        .bind(handle, thumb.publicKey)
        .accounts({ payer: provider.wallet.publicKey, verifier: signer.publicKey, ...accounts })
        .preInstructions([deviceSignature(owner, bindMessage(handle, thumb.publicKey.toBase58()))])
        .signers([signer])
        .rpc();
    await rejects(bind(Keypair.generate()), "NotVerified"); // the device alone cannot claim a handle
    const impostor = Keypair.generate(); // signs correctly but does not hold the Genesis Token
    await rejects(
      program.methods
        .bind(handle, thumb.publicKey)
        .accounts({ payer: provider.wallet.publicKey, verifier: verifier.publicKey, ...accounts, owner: impostor.publicKey })
        .preInstructions([deviceSignature(impostor, bindMessage(handle, thumb.publicKey.toBase58()))])
        .signers([verifier])
        .rpc(),
      "NotSeeker",
    );
    await bind(verifier);

    const signature = await program.methods.attest().accounts(accounts).preInstructions([deviceSignature(thumb, attestMessage(handle, text))]).rpc();
    const [event] = await events(signature);
    assert.equal(event.name, "attested");
    assert.equal(event.data.handle, handle);
    assert.deepEqual(Array.from(event.data.textHash), Array.from(createHash("sha256").update(text).digest()));
    assert.equal(event.data.sgtMint.toBase58(), sgtMint.toBase58());
  });

  it("records an address named in an approved post where any program can find it", async () => {
    const mint = Keypair.generate().publicKey;
    const post = `Our only token is ${mint.toBase58()}. Anything else is fake.`;
    const endorse = (address: PublicKey) =>
      program.methods.endorse(address).accounts({ payer: provider.wallet.publicKey, ...accounts }).preInstructions([deviceSignature(thumb, attestMessage(handle, post))]).rpc();
    await rejects(endorse(Keypair.generate().publicKey), "AddressNotInPost"); // the server cannot slip in another address
    const names = (await events(await endorse(mint))).map((event) => event.name);
    assert.deepEqual(names, ["attested", "endorsed"]);
    const [record] = PublicKey.findProgramAddressSync([Buffer.from("address"), Buffer.from(handle), mint.toBuffer()], program.programId);
    assert.equal((await program.account.endorsement.fetch(record)).address.toBase58(), mint.toBase58());
    // Anyone's transaction can carry the check. It passes for the approved address only, and
    // stops passing the moment the owner reports the account as taken over.
    const [status] = PublicKey.findProgramAddressSync([Buffer.from("status"), Buffer.from(handle)], program.programId);
    const check = (address: PublicKey) =>
      program.methods.check(handle, address).accounts({ endorsement: PublicKey.findProgramAddressSync([Buffer.from("address"), Buffer.from(handle), address.toBuffer()], program.programId)[0], status }).rpc();
    await check(mint);
    await rejects(check(Keypair.generate().publicKey), "NeverApproved");
    const count = 0; // each report or key move uses the next number
    const flag = (compromised: boolean, at: number) =>
      program.methods.setCompromised(compromised).accounts({ payer: provider.wallet.publicKey, ...accounts }).preInstructions([deviceSignature(thumb, flagMessage(handle, compromised, at))]).rpc();
    await flag(true, count);
    await rejects(check(mint), "ReportedCompromised");
    await flag(false, count + 1);
    await check(mint);
  });

  it("rejects an action with no device signature, or one signed for another account", async () => {
    await rejects(program.methods.attest().accounts(accounts).rpc(), "NotSigned");
    const wrongHandle = deviceSignature(thumb, attestMessage("x:someoneelse", text));
    await rejects(program.methods.attest().accounts(accounts).preInstructions([wrongHandle]).rpc(), "WrongMessage");
  });

  it("rejects another wallet acting for this device", async () => {
    const impostor = Keypair.generate();
    const signed = deviceSignature(impostor, attestMessage(handle, text));
    await rejects(program.methods.attest().accounts({ ...accounts, owner: impostor.publicKey }).preInstructions([signed]).rpc(), "NotOwner");
  });

  it("flags the account as compromised, and refuses a replayed signature", async () => {
    const report = deviceSignature(thumb, flagMessage(handle, true, 2));
    const [event] = await events(await program.methods.setCompromised(true).accounts({ payer: provider.wallet.publicKey, ...accounts }).preInstructions([report]).rpc());
    assert.equal(event.name, "flagged");
    assert.equal(event.data.compromised, true);
    await rejects(program.methods.setCompromised(true).accounts({ payer: provider.wallet.publicKey, ...accounts }).preInstructions([report]).rpc(), "WrongMessage");
  });

  it("accepts only the fingerprint key for posts, and lets the wallet move it", async () => {
    // The wallet key alone (which a PIN can unlock) cannot approve a post.
    await rejects(program.methods.attest().accounts(accounts).preInstructions([deviceSignature(owner, attestMessage(handle, text))]).rpc(), "NotSigned");
    const replacement = Keypair.generate();
    const move = approverMessage(handle, replacement.publicKey.toBase58(), 3);
    await rejects(program.methods.setApprover(replacement.publicKey).accounts(accounts).preInstructions([deviceSignature(thumb, move)]).rpc(), "NotSigned");
    await program.methods.setApprover(replacement.publicKey).accounts(accounts).preInstructions([deviceSignature(owner, move)]).rpc();
    await rejects(program.methods.attest().accounts(accounts).preInstructions([deviceSignature(thumb, attestMessage(handle, "old key"))]).rpc(), "NotSigned");
    thumb = replacement;
    await program.methods.attest().accounts(accounts).preInstructions([deviceSignature(thumb, attestMessage(handle, "new key"))]).rpc();
  });

  it("rejects a second handle for the same device", async () => {
    const error = await program.methods
      .bind("x:second", thumb.publicKey)
      .accounts({ payer: provider.wallet.publicKey, verifier: verifier.publicKey, ...accounts })
      .preInstructions([deviceSignature(owner, bindMessage("x:second", thumb.publicKey.toBase58()))])
      .signers([verifier])
      .rpc()
      .then(() => null, (thrown) => thrown);
    assert.ok(error, "second bind was accepted");
  });
});
