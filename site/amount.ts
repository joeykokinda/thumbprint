export function solToLamports(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(value)) throw new Error("Enter a positive SOL amount with at most nine decimal places");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
  if (amount <= 0n || amount > 100_000_000n) throw new Error("This devnet demo accepts up to 0.1 test SOL per payment");
  return amount;
}

