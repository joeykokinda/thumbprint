// Thumbprint content script for x.com.
// Marks posts approved on a Seeker, warns on unsigned posts from accounts that sign,
// and adds "Post with Thumbprint" to the composer. All network goes through background.js.

const FINGERPRINT_ICON = `<svg class="tp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .131-5.354 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/></svg>`;

// Text as the author typed it: emoji come from <img alt>, shortened links are skipped.
function visibleText(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeName === "IMG") return node.alt || "";
  if (node.nodeName === "A" && /^https?:\/\/t\.co\//.test(node.href)) return " ";
  return Array.from(node.childNodes, visibleText).join("");
}

function readPost(article) {
  const textElement = article.querySelector('[data-testid="tweetText"]');
  const profileLink = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
  if (!textElement || !profileLink) return null;
  const text = normalizeText(visibleText(textElement));
  if (!text) return null;
  return {
    handle: "x:" + profileLink.getAttribute("href").slice(1).toLowerCase(),
    text,
    postedAt: article.querySelector("time")?.dateTime || null,
    textElement,
    nameElement: article.querySelector('[data-testid="User-Name"]'),
  };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function timeAgo(isoOrSeconds) {
  const then = typeof isoOrSeconds === "number" ? isoOrSeconds * 1000 : Date.parse(isoOrSeconds);
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

function clearMarks(article) {
  article.classList.remove("tp-certified", "tp-unsigned", "tp-dim");
  article.querySelectorAll(".tp-badge, .tp-warning").forEach((node) => node.remove());
}

// The detail card lives on <body> with fixed positioning: inside a post it gets clipped
// by the timeline column and painted over by quoted posts.
let openCard = null;
let hideTimer = null;

function hideCard() {
  openCard?.remove();
  openCard = null;
}

function showCard(badge, result) {
  clearTimeout(hideTimer);
  hideCard();
  const card = element("div", "tp-card");
  const heading = element("div", "tp-card-heading");
  heading.innerHTML = FINGERPRINT_ICON;
  heading.append(element("span", null, "Approved on a real device"));
  card.append(heading, element("div", "tp-card-line", "A person pressed their thumb on a Seeker to approve this exact post."));
  const facts = element("div", "tp-card-facts");
  const addFact = (label, value) => {
    const row = element("div", "tp-card-fact");
    row.append(element("span", "tp-card-fact-label", label), element("span", "tp-card-fact-value", value));
    facts.append(row);
  };
  addFact("Approved", timeAgo(result.timestamp));
  addFact("Device", `${result.sgtMint.slice(0, 4)}…${result.sgtMint.slice(-4)}`);
  addFact("This device, last 24h", `${result.recentCount} ${result.recentCount === 1 ? "post" : "posts"}`);
  card.append(facts);
  if (result.proofUrl) {
    const link = element("a", "tp-card-link", "View proof on Solana");
    link.href = result.proofUrl;
    link.target = "_blank";
    link.rel = "noopener";
    card.append(link);
  }
  card.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  card.addEventListener("mouseleave", scheduleHide);
  document.body.append(card);
  const anchor = badge.getBoundingClientRect();
  const size = card.getBoundingClientRect();
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - size.width - 8));
  const below = anchor.bottom + 8;
  const top = below + size.height > window.innerHeight - 8 ? Math.max(8, anchor.top - size.height - 8) : below;
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  openCard = card;
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideCard, 200);
}
window.addEventListener("scroll", hideCard, { passive: true });

function markCertified(article, post, result) {
  article.classList.add("tp-certified");
  const badge = element("span", "tp-badge");
  badge.tabIndex = 0;
  badge.setAttribute("role", "button");
  badge.setAttribute("aria-label", "Thumbprint: approved on a real device. Show details.");
  badge.innerHTML = FINGERPRINT_ICON;
  badge.append(element("span", "tp-badge-label", "Thumbprint"));
  badge.addEventListener("mouseenter", () => showCard(badge, result));
  badge.addEventListener("focus", () => showCard(badge, result));
  badge.addEventListener("mouseleave", scheduleHide);
  badge.addEventListener("blur", scheduleHide);
  badge.addEventListener("click", (event) => event.stopPropagation());
  post.nameElement.append(badge);
}

function markUnsigned(article, post) {
  article.classList.add("tp-unsigned");
  const warning = element("div", "tp-warning");
  warning.setAttribute("role", "alert");
  const title = element("div", "tp-warning-title");
  title.innerHTML = FINGERPRINT_ICON;
  title.append(element("span", null, "Not signed. Be careful."));
  warning.append(
    title,
    element(
      "div",
      "tp-warning-body",
      `@${post.handle.slice(2)} approves every post with Thumbprint. This one was not approved on their device, so the account may be compromised. Do not click links or connect a wallet.`
    )
  );
  post.textElement.before(warning);
}

let dimUnsigned = false;
chrome.storage?.sync.get({ dimUnsigned: false }).then((settings) => {
  dimUnsigned = settings.dimUnsigned;
  scan();
});
chrome.storage?.onChanged.addListener((changes) => {
  if (changes.dimUnsigned) {
    dimUnsigned = changes.dimUnsigned.newValue;
    document.querySelectorAll("article[data-tp-key]").forEach((article) => delete article.dataset.tpKey);
    scan();
  }
});

async function scan() {
  const pending = [];
  for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
    const post = readPost(article);
    if (!post) continue;
    const key = `${post.handle}|${post.text}`;
    if (article.dataset.tpKey === key) continue;
    article.dataset.tpKey = key;
    pending.push({ article, post, key });
  }
  if (!pending.length) return;

  const items = await Promise.all(
    pending.map(async ({ post }) => ({ handle: post.handle, hash: await sha256Hex(post.text), postedAt: post.postedAt }))
  );
  let results;
  try {
    results = await chrome.runtime.sendMessage({ type: "lookup", items });
  } catch {
    results = null;
  }
  pending.forEach(({ article, post, key }, index) => {
    if (article.dataset.tpKey !== key) return; // X recycled the node while we waited
    clearMarks(article);
    const result = results?.[index];
    if (!result) return delete article.dataset.tpKey; // lookup failed, retry on next scan
    if (result.state === "certified") markCertified(article, post, result);
    else if (result.state === "unsigned") markUnsigned(article, post);
    else if (dimUnsigned) article.classList.add("tp-dim");
  });
}

// ---- Composer ----

function myHandle() {
  const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  return profileLink ? "x:" + profileLink.getAttribute("href").slice(1).toLowerCase() : null;
}

function composerText(toolbar) {
  for (let node = toolbar.parentElement; node; node = node.parentElement) {
    const editor = node.querySelector('[data-testid^="tweetTextarea_"]');
    if (editor) return normalizeText(visibleText(editor));
  }
  return "";
}

function setButtonState(button, state, label) {
  button.dataset.state = state;
  button.querySelector(".tp-button-label").textContent = label;
  button.disabled = state === "waiting";
}

function addComposerButtons() {
  for (const postButton of document.querySelectorAll('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]')) {
    // X wraps Post in a column that fades when the composer is empty; the row around
    // that wrapper is where a sibling button sits level with Post.
    const wrapper = postButton.parentElement;
    const container = wrapper?.parentElement;
    if (!container || container.querySelector(".tp-button")) continue;
    const inline = postButton.dataset.testid === "tweetButtonInline"; // tight on space
    const idleLabel = inline ? "Thumbprint" : "Post with Thumbprint";
    const button = element("button", "tp-button");
    button.type = "button";
    button.innerHTML = FINGERPRINT_ICON;
    button.append(element("span", "tp-button-label"));
    button.title = "Post with Thumbprint: approve this post on your Seeker";
    setButtonState(button, "idle", idleLabel);
    button.addEventListener("click", async () => {
      const handle = myHandle();
      const text = composerText(container);
      if (!handle || !text) return setButtonState(button, "error", "Write something first");
      setButtonState(button, "waiting", "Check your Seeker");
      let response;
      try {
        response = await chrome.runtime.sendMessage({ type: "approve", handle, text });
      } catch {
        response = null;
      }
      if (response?.ok) {
        setButtonState(button, "done", "Certified");
        postButton.click();
      } else {
        setButtonState(button, "error", response?.reason || "Not approved");
      }
      setTimeout(() => setButtonState(button, "idle", idleLabel), 4000);
    });
    wrapper.before(button);
  }
}

let scheduled = false;
new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    scan();
    addComposerButtons();
  }, 250);
}).observe(document.body, { childList: true, subtree: true });
scan();
addComposerButtons();
