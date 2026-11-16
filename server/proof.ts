// Proof that whoever links a handle controls that X account: they publish a post carrying a
// code derived from their device's wallet, and we read the post back from X's public embed
// endpoint, which needs no API key.
import { createHash } from "node:crypto";

export const proofCode = (owner: string) => "tp_" + createHash("sha256").update(`thumbprint:${owner}`).digest("hex").slice(0, 10);

export const postId = (link: string) => link.match(/(?:x|twitter)\.com\/\w+\/status\/(\d+)/)?.[1] ?? null;

/** The handle that posted, if the post carries this device's code. */
export function provenHandle(post: any, owner: string): string | null {
  const name = post?.user?.screen_name;
  if (typeof name !== "string" || !String(post.text ?? "").includes(proofCode(owner))) return null;
  return "x:" + name.toLowerCase();
}

// ponytail: an undocumented endpoint X can change. Upgrade path: the official API, or a zkTLS proof.
export async function fetchPost(id: string) {
  const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
  const response = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}`, { headers: { "user-agent": "Mozilla/5.0" } });
  return response.ok ? response.json().catch(() => null) : null;
}

export async function verifyProof(owner: string, link: string): Promise<string> {
  const id = postId(link);
  if (!id) throw new Error("That is not a link to a post on X.");
  const handle = provenHandle(await fetchPost(id), owner);
  if (!handle) throw new Error("That post does not carry this Seeker's code. Post the text exactly as shown, then paste its link.");
  return handle;
}
