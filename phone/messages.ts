// The exact strings the device signs. The program rebuilds them onchain (see lib.rs) and the
// wallet shows them to the owner, so any change here must be made there too.
export const bindMessage = (handle: string, approver: string) => `Thumbprint: link ${handle} to this Seeker\nPosts are approved by key ${approver}`;
export const PROGRAM_ID = "EerbNxsSbeADJLet2sYBZwC9eKmQPYDv3UaohaMRmriS";
export const domain = (network = "devnet") => `Thumbprint v2 | ${network} | ${PROGRAM_ID}`;
// The counter makes each post approval single use: the program consumes it.
export const attestMessage = (handle: string, text: string, count: number, network = "devnet") => `${domain(network)}\nApprove post as ${handle} (#${count})\n\n${text}`;
export const flagMessage = (handle: string, compromised: boolean, count: number) =>
  `${domain()}\nReport ${handle} as ${compromised ? "compromised" : "recovered"} (#${count})`;
export const hardwareMessage = (handle: string, keyHex: string, evidence: string, count: number, network = "devnet") =>
  `${domain(network)}\nEnroll biometric key for ${handle}\nKey: ${keyHex}\nEvidence: ${evidence}\nCounter: ${count}`;
export const destinationMessage = (handle: string, recipient: string, expires: number, enabled: boolean, count: number, network = "devnet") =>
  `${domain(network)}\n${enabled ? "Approve" : "Revoke"} treasury payments for ${handle}\nRecipient: ${recipient}\nExpires: ${expires}\nCounter: ${count}`;
