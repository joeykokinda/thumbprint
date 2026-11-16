const dim = document.getElementById("dim");
chrome.storage.sync.get({ dimUnsigned: false }).then((settings) => (dim.checked = settings.dimUnsigned));
dim.addEventListener("change", () => chrome.storage.sync.set({ dimUnsigned: dim.checked }));

// The background worker owns the session id; asking it makes sure one exists.
chrome.runtime.sendMessage({ type: "session" }).then(({ server, session }) => {
  const status = document.getElementById("status");
  const statusText = document.getElementById("status-text");
  const pairing = document.getElementById("pairing");
  document.getElementById("qr").src = `${server}/v1/qr?session=${session}`;
  const check = async () => {
    let label = "Server unreachable";
    let paired = false;
    try {
      paired = (await (await fetch(`${server}/v1/paired?session=${session}`)).json()).paired;
      label = paired ? "Paired" : "Not paired";
    } catch {}
    statusText.textContent = label;
    status.classList.toggle("on", paired);
    pairing.hidden = paired;
  };
  check();
  setInterval(check, 1500);
});
