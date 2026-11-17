import { TransactionInstruction, PublicKey } from "@solana/web3.js";

const ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const integer = (bytes: Uint8Array) => BigInt("0x" + Buffer.from(bytes).toString("hex"));

// Android ECDSA returns DER; Solana expects fixed-width r,s with low S.
export function compactP256(input: Uint8Array): Buffer {
  const data = Buffer.from(input);
  let compact: Buffer;
  if (data.length === 64) compact = Buffer.from(data);
  else {
    if (data[0] !== 0x30 || data[1] !== data.length - 2 || data[2] !== 2) throw new Error("Invalid ECDSA signature");
    const size = data[3];
    const offset = 4 + size;
    if (data[offset] !== 2 || offset + 2 + data[offset + 1] !== data.length) throw new Error("Invalid ECDSA signature");
    const scalar = (bytes: Buffer) => {
      if (!bytes.length || bytes[0] & 0x80 || bytes.length > 33 || (bytes.length === 33 && bytes[0] !== 0)) throw new Error("Invalid ECDSA scalar");
      const n = integer(bytes);
      if (n <= 0n || n >= ORDER) throw new Error("Invalid ECDSA scalar");
      return Buffer.from(n.toString(16).padStart(64, "0"), "hex");
    };
    compact = Buffer.concat([scalar(data.subarray(4, offset)), scalar(data.subarray(offset + 2))]);
  }
  const r = integer(compact.subarray(0, 32)), s = integer(compact.subarray(32));
  if (r <= 0n || r >= ORDER || s <= 0n || s >= ORDER) throw new Error("Invalid ECDSA scalar");
  if (s > ORDER / 2n) Buffer.from((ORDER - s).toString(16).padStart(64, "0"), "hex").copy(compact, 32);
  return compact;
}

export function p256Instruction(key: Uint8Array, message: string, signature: Uint8Array) {
  if (key.length !== 33 || (key[0] !== 2 && key[0] !== 3)) throw new Error("Invalid compressed P-256 key");
  const text = Buffer.from(message);
  if (text.length > 640) throw new Error("Message too long");
  const data = Buffer.alloc(16 + 33 + 64 + text.length);
  data[0] = 1;
  [49, 65535, 16, 65535, 113, text.length, 65535].forEach((value, i) => data.writeUInt16LE(value, 2 + i * 2));
  Buffer.from(key).copy(data, 16);
  compactP256(signature).copy(data, 49);
  text.copy(data, 113);
  return new TransactionInstruction({ programId: new PublicKey("Secp256r1SigVerify1111111111111111111111111"), keys: [], data });
}
