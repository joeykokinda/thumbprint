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
const chrome = {
  runtime: {
    sendMessage: (message) =>
      new Promise((resolve) => {
        if (message.type !== "lookup" && message.type !== "approve") return resolve(null);
        const id = String(++lastRequest);
        waiting.set(id, resolve);
        // An approval waits on a person; if the phone page never answers, stop the spinner.
        setTimeout(() => window.thumbprintReply(id, message.type === "approve" ? '{"ok":false,"reason":"Not approved in time"}' : "null"), 120_000);
        ThumbprintHost.send(id, message.type, message.type === "lookup" ? JSON.stringify(message.items) : message.text);
      }),
  },
};
