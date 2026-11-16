// The exact strings the device signs. The program rebuilds them onchain (see lib.rs) and the
// wallet shows them to the owner, so any change here must be made there too.
export const bindMessage = (handle: string, approver: string) => `Thumbprint: link ${handle} to this Seeker\nPosts are approved by key ${approver}`;
export const approverMessage = (handle: string, approver: string, count: number) =>
  `Thumbprint: ${handle} posts are now approved by key ${approver} (#${count})`;
export const attestMessage = (handle: string, text: string) => `Thumbprint: approve this post as ${handle}\n\n${text}`;
export const flagMessage = (handle: string, compromised: boolean, count: number) =>
  `Thumbprint: report ${handle} as ${compromised ? "compromised" : "recovered"} (#${count})`;
