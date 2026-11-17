import { expect, test } from "bun:test";
import { verifyHardware } from "./enrollment.ts";

test("missing, oversized and malformed attestation input fails before any registration", async () => {
  for (const evidence of [null, [], ["not a certificate"], Array(9).fill("fake"), Array(3).fill("x".repeat(16001))]) {
    await expect(verifyHardware(evidence, "challenge", "signature")).rejects.toThrow("Invalid attestation certificates");
  }
});
