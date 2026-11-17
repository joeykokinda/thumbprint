// Stands in for the extension's background worker when x.com runs inside the Thumbprint app.
// X's content policy stops page script from reaching our server, so requests go through the app.
const waiting = new Map();
let lastRequest = 0;
window.thumbprintReply = (id, result) => {
  const resolve = waiting.get(id);
  waiting.delete(id);
  try {
    resolve?.(JSON.parse(result));
  } catch {
    resolve?.(null);
  }
};
function sendToHost(type, body) {
  return new Promise(resolve => {
    const id = String(++lastRequest);
    waiting.set(id, resolve);
    setTimeout(() => window.thumbprintReply(id, type === "approve" ? '{"ok":false,"reason":"Not approved in time"}' : "null"), 120000);
    ThumbprintHost.send(id, type, body);
  });
}
const verified = new Map();
const chrome = {
  runtime: {
    sendMessage: async message => {
      if (message.type !== "lookup" && message.type !== "approve") return null;
      const result = await sendToHost(message.type, message.type === "lookup" ? JSON.stringify(message.items) : message.text);
      if (message.type !== "lookup" || !Array.isArray(result)) return result;
      return Promise.all(result.map(async (entry, index) => {
        if (entry.state !== "certified") return entry;
        const item = message.items[index];
        const cacheKey = `${entry.signature}|${item.handle}|${item.hash}|${item.postedAt}`;
        try {
          const proof = verified.get(cacheKey) || await verifyThumbprintPost(entry.signature, item.handle, { hash: item.hash, postedAt: item.postedAt ?? null }, async signature => {
            const response = await sendToHost("proof", signature);
            return response?.result;
          });
          if (verified.size > 500) verified.clear();
          verified.set(cacheKey, proof);
          return { ...entry, timestamp: proof.timestamp, sgtMint: proof.sgtMint };
        } catch { return { state: "none", verificationUnavailable: true }; }
      }));
    },
  },
};
