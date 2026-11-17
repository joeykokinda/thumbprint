// Shared by the content script, the background worker, the phone page and the dev tools.
// The same text must produce the same fingerprint everywhere, so this is the only copy.

// Link hosts are for display only. Approval hashing retains the full original URL.
globalThis.URL_PATTERN = /https?:\/\/\S+|\b(?:[\w-]+\.)+[a-z]{2,}\b\S*/gi;

globalThis.linkDomain = function (link) {
  return link
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[\/?#\u2026]/)[0]
    .replace(/[^a-z0-9]+$/, "");
};

globalThis.normalizeText = function (text) {
  // Never fold URL paths, queries, schemes, Unicode characters, or internal whitespace.
  return text.replace(/\r\n?/g, "\n").trim();
};

globalThis.sha256Hex = async function (text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

