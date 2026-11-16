// The exact strings the device signs. The program rebuilds them onchain (see lib.rs) and the
// wallet shows them to the owner, so any change here must be made there too.
export const bindMessage = (handle: string) => `Thumbprint: link ${handle} to this Seeker`;
export const attestMessage = (handle: string, text: string) => `Thumbprint: approve this post as ${handle}\n\n${text}`;
export const flagMessage = (handle: string, compromised: boolean, count: number) =>
  `Thumbprint: report ${handle} as ${compromised ? "compromised" : "recovered"} (#${count})`;
