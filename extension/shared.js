// Shared by the content script, the background worker, the phone page and the dev tools.
// The same text must produce the same fingerprint everywhere, so this is the only copy.

// ponytail: links are left out of the hash because X rewrites and truncates them.
// A bare domain typed with an unlisted TLD can still mismatch. Upgrade path: hash the
// expanded URL from the link's title attribute on both sides.
globalThis.URL_PATTERN = /https?:\/\/\S+|\b[\w-]+\.(?:com|org|net|io|xyz|co|app|dev|gg|fi|so|me|ai)\b\S*/gi;

globalThis.normalizeText = function (text) {
  return text.normalize("NFKC").replace(URL_PATTERN, " ").replace(/\s+/g, " ").trim();
};

globalThis.sha256Hex = async function (text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

