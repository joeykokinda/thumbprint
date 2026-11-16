import { expect, test } from "bun:test";
import { main } from "./filter.js";

test("forwards only successful Thumbprint transactions", () => {
  const ours = "Program BYeu5eZoiHT7JWYbaECxWdi3awPKMoZspYnnEN5uHUjc invoke [1]";
  const transaction = (logs: string[], err: unknown = null) => ({ meta: { err, logMessages: logs }, transaction: { signatures: ["sig"] } });
  const block = { blockTime: 7, transactions: [transaction(["Program Vote111 invoke [1]"]), transaction([ours, "Program data: abc"]), transaction([ours], { failed: true })] };
  expect(main({ data: [block] })).toEqual({ transactions: [{ signature: "sig", blockTime: 7, logs: [ours, "Program data: abc"] }] });
  expect(main({ data: [{ blockTime: 8, transactions: [transaction(["Program Vote111 invoke [1]"])] }] })).toBeNull();
});
