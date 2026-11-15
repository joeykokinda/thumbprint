const dim = document.getElementById("dim");
chrome.storage.sync.get({ dimUnsigned: false }).then((settings) => (dim.checked = settings.dimUnsigned));
dim.addEventListener("change", () => chrome.storage.sync.set({ dimUnsigned: dim.checked }));

chrome.storage.local.get({ server: "http://localhost:8787", session: null }).then(async ({ server, session }) => {
  const status = document.getElementById("status");
  try {
    const { paired } = await (await fetch(`${server}/v1/paired?session=${session}`)).json();
    status.textContent = paired ? "Phone connected." : "No phone connected.";
  } catch {
    status.textContent = "Server unreachable.";
  }
});
