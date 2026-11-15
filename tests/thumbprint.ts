import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "crypto";
import type { Thumbprint } from "../target/types/thumbprint";

const { Keypair, PublicKey } = anchor.web3;
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

describe("thumbprint", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.thumbprint as Program<Thumbprint>;

  const owner = Keypair.fromSecretKey(Uint8Array.from(fixture("owner.json")));
  const sgtMint = new PublicKey("5mXbkqKz883aufhAsx3p5Z1NcvD2ppZbdTTznM6oUKLj");
  const sgtTokenAccount = new PublicKey(fixture("sgt_token_account.json").pubkey);
  const handle = "x:tester";
  const textHash = Array.from(createHash("sha256").update("hello from a real thumb").digest());

  it("binds a handle and attests a post for a Genesis Token holder", async () => {
    await program.methods
      .bind(handle)
      .accounts({ payer: provider.wallet.publicKey, owner: owner.publicKey, sgtTokenAccount, sgtMint })
      .signers([owner])
      .rpc();

    const signature = await program.methods
      .attest(textHash)
      .accounts({ owner: owner.publicKey, sgtTokenAccount, sgtMint })
      .signers([owner])
      .rpc();
    await provider.connection.confirmTransaction(signature, "confirmed");

    const transaction = await provider.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const events = [...new anchor.EventParser(program.programId, program.coder).parseLogs(transaction.meta.logMessages)];
    assert.equal(events[0].name, "attested");
    assert.equal(events[0].data.handle, handle);
    assert.deepEqual(Array.from(events[0].data.textHash), textHash);
    assert.equal(events[0].data.sgtMint.toBase58(), sgtMint.toBase58());
  });

  it("rejects a signer who does not hold the token", async () => {
    const impostor = Keypair.generate();
    try {
      await program.methods
        .attest(textHash)
        .accounts({ owner: impostor.publicKey, sgtTokenAccount, sgtMint })
        .signers([impostor])
        .rpc();
      assert.fail("impostor was accepted");
    } catch (error) {
      assert.equal(error.error?.errorCode?.code, "NotSeeker");
    }
  });

  it("rejects a second handle for the same device", async () => {
    try {
      await program.methods
        .bind("x:second")
        .accounts({ payer: provider.wallet.publicKey, owner: owner.publicKey, sgtTokenAccount, sgtMint })
        .signers([owner])
        .rpc();
      assert.fail("second bind was accepted");
    } catch (error) {
      assert.notEqual(error.message, "second bind was accepted");
    }
  });
});
