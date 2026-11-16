// Shared by the content script, the background worker, the phone page and the dev tools.
// The same text must produce the same fingerprint everywhere, so this is the only copy.

// Each link is reduced to its domain and kept in the hash, so copying a signed post's wording
// and pointing it at a different site does not carry the signature along.
// ponytail: binds the domain, not the full path, because X truncates long links on screen.
// Anything shaped like a domain counts as a link. Both sides run this same rule, so matching
// too much is harmless; matching too little would make a signed post read as unsigned.
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
  return text
    .normalize("NFKC")
    .replace(URL_PATTERN, (link) => ` [${linkDomain(link)}] ${link.replace(/\.{3}$/, "").match(/[.,;:!?)\]'"]*$/)[0]}`)
    .replace(/\s+/g, " ")
    .trim();
};

globalThis.sha256Hex = async function (text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

