import { verifyPostProof } from "../lib/post-proof.ts";
(globalThis as any).verifyThumbprintPost = verifyPostProof;
