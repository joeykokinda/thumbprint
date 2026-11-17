import { expect, test } from "bun:test";
import { solToLamports } from "./amount.ts";

test("payment amounts are exact integer lamports with no rounding or ambiguous input", () => {
  expect(solToLamports("0.001")).toBe(1_000_000n);
  expect(solToLamports("0.000000001")).toBe(1n);
  expect(solToLamports("0.1")).toBe(100_000_000n);
  for (const value of ["0", "-1", "NaN", "1e-3", "0.0000000001", "0.100000001", "01", ".001", "0.1SOL"]) expect(() => solToLamports(value)).toThrow();
});
