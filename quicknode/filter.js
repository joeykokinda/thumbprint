// QuickNode Stream filter. Network: Solana devnet. Dataset: Block. Destination: webhook to
// POST {server}/v1/stream?token={STREAM_TOKEN}.
// Keeps only successful transactions that invoke the Thumbprint program and forwards their
// signature, time and logs; every other block is dropped (null), so the server sees nothing else.
const PROGRAM_ID = "BYeu5eZoiHT7JWYbaECxWdi3awPKMoZspYnnEN5uHUjc";

function main(stream) {
  const blocks = [stream.data ?? stream].flat(Infinity);
  const transactions = [];
  for (const block of blocks) {
    for (const entry of block?.transactions ?? []) {
      const logs = entry?.meta?.logMessages ?? [];
      if (entry?.meta?.err || !logs.some((line) => line.startsWith(`Program ${PROGRAM_ID} invoke`))) continue;
      transactions.push({ signature: entry.transaction.signatures[0], blockTime: block.blockTime, logs });
    }
  }
  return transactions.length ? { transactions } : null;
}

if (typeof module !== "undefined") module.exports = { main };
