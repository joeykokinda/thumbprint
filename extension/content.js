// Thumbprint content script for x.com.
// Marks posts approved on a Seeker, flags unsigned posts from accounts that sign,
// and adds a "Sign with Thumbprint" control to the composer. Network goes through background.js.

const svg = (body) =>
  `<svg class="tp-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = {
  mark: svg('<path d="M4 15v-3a8 8 0 0 1 3.2-6.4"/><path d="M10.4 4.16A8 8 0 0 1 20 12v4"/><path d="M8 19v-7a4 4 0 0 1 8 0v7"/><path d="M12 12v8"/>'),
  // Same glyph with a strike, so "not signed" does not rely on color alone.
  unsigned: svg('<path d="M4 15v-3a8 8 0 0 1 3.2-6.4"/><path d="M10.4 4.16A8 8 0 0 1 20 12v4"/><path d="M8 19v-7a4 4 0 0 1 8 0v7"/><path d="M12 12v8"/><path d="M3 3l18 18" stroke-width="2.5"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  alert: svg('<path d="M12 4 2.8 20h18.4L12 4z"/><path d="M12 10v4.5"/><path d="M12 17.4v.1"/>'),
  spinner: svg('<path d="M12 3a9 9 0 1 0 9 9"/>'),
};

// Text as the author typed it: emoji come from <img alt>, links keep their visible address.
function visibleText(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeName === "IMG") return node.alt || "";
  if (node.nodeName === "A" && /^https?:\/\/t\.co\//.test(node.href)) return ` https://${node.textContent.replace(/^https?:\/\//, "")} `;
  const text = Array.from(node.childNodes, visibleText).join("");
  return node.dataset?.block ? text + "\n" : text; // the composer keeps each line in its own block
}

const ADDRESS_PATTERN = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

function readPost(article) {
  const textElement = article.querySelector('[data-testid="tweetText"]');
  const nameElement = article.querySelector('[data-testid="User-Name"]');
  const profileLink = nameElement?.querySelector('a[href^="/"]');
  if (!textElement || !profileLink) return null;
  // A quote with no words of its own would be judged on the quoted author's text.
  if (textElement.closest('[role="link"]')) return null;
  // ponytail: a post cut off by "Show more" cannot be hashed from the timeline, so it gets no
  // mark either way. Upgrade path: fetch the full text, or check it on the post's own page.
  if (article.querySelector('[data-testid="tweet-text-show-more-link"]')) return null;
  const text = normalizeText(visibleText(textElement));
  if (!text) return null;
  return {
    handle: "x:" + profileLink.getAttribute("href").slice(1).toLowerCase(),
    text,
    postedAt: article.querySelector("time")?.dateTime || null,
    addresses: text.match(ADDRESS_PATTERN) || [],
    textElement,
    profileLink,
  };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function iconElement(name, className) {
  const wrapper = element("span", className);
  wrapper.innerHTML = ICONS[name];
  return wrapper;
}

// X ships three themes and gives no stable class for them, so read the page background.
function applyTheme() {
  const channels = getComputedStyle(document.body).backgroundColor.match(/\d+/g)?.map(Number) || [255, 255, 255];
  const brightness = channels[0] + channels[1] + channels[2];
  document.documentElement.dataset.tpTheme = brightness > 600 ? "light" : brightness > 30 ? "dim" : "dark";
}

// ---- Detail card (on <body>, fixed: inside a post it is clipped and painted over) ----

let openCard = null;
let showTimer = null;
let hideTimer = null;

function hideCard() {
  clearTimeout(showTimer);
  openCard?.remove();
  openCard = null;
}

function scheduleHide() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideCard, 180);
}

function showCard(anchor, result) {
  clearTimeout(hideTimer);
  hideCard();
  const card = element("div", "tp-card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Thumbprint proof");
  const header = element("div", "tp-card-header");
  header.append(iconElement("mark", "tp-card-glyph"), element("span", null, "Signed with fingerprint"));
  card.append(header, element("p", "tp-card-lede", "The account owner approved this exact post on their Seeker."));

  const rows = element("dl", "tp-card-rows");
  const addRow = (label, value, className) => {
    const row = element("div", "tp-card-row");
    row.append(element("dt", null, label), element("dd", className, value));
    rows.append(row);
  };
  addRow(
    "Approved",
    new Date(result.timestamp * 1000).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })
  );
  addRow("Device", `${result.sgtMint.slice(0, 4)}…${result.sgtMint.slice(-4)}`, "tp-mono");
  rows.lastElementChild.lastElementChild.prepend(element("span", "tp-device-kind", "Seeker · "));
  const busy = result.recentCount > 50;
  addRow(
    "Last 24h",
    `${result.recentCount} ${result.recentCount === 1 ? "post" : "posts"} approved${busy ? ", unusually high" : ""}`,
    busy ? "tp-warn-text" : null
  );
  card.append(rows);
  if (result.proofUrl) {
    const link = element("a", "tp-card-link", "View proof ↗");
    link.href = result.proofUrl;
    link.target = "_blank";
    link.rel = "noopener";
    card.append(link);
  }
  card.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  card.addEventListener("mouseleave", scheduleHide);
  document.body.append(card);

  const anchorBox = anchor.getBoundingClientRect();
  const cardBox = card.getBoundingClientRect();
  const left = Math.max(8, Math.min(anchorBox.left - 16, window.innerWidth - cardBox.width - 8));
  const below = anchorBox.bottom + 8;
  const top = below + cardBox.height > window.innerHeight - 8 ? Math.max(8, anchorBox.top - cardBox.height - 8) : below;
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  openCard = card;
}
window.addEventListener("scroll", hideCard, { passive: true });
document.addEventListener("keydown", (event) => event.key === "Escape" && hideCard());

// ---- Marks on posts ----

function clearMarks(article) {
  article.classList.remove("tp-dim");
  article.querySelectorAll(".tp-mark, .tp-notice, .tp-address").forEach((node) => node.remove());
}

function markCertified(post, result) {
  const mark = iconElement("mark", "tp-mark");
  mark.tabIndex = 0;
  mark.setAttribute("role", "button");
  mark.setAttribute("aria-label", "Signed with fingerprint, view proof");
  mark.addEventListener("mouseenter", () => {
    clearTimeout(hideTimer);
    showTimer = setTimeout(() => showCard(mark, result), 350);
  });
  mark.addEventListener("mouseleave", scheduleHide);
  mark.addEventListener("focus", () => showCard(mark, result));
  mark.addEventListener("blur", scheduleHide);
  mark.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showCard(mark, result);
  });
  // Inside the name link's own row, right after X's badge. The click handler above keeps
  // a click on the mark from following the profile link.
  quietHover(mark);
  (post.profileLink.firstElementChild || post.profileLink).append(mark);
}

// A Solana address that some account's phone approved, in anyone's post. The record is an
// account on Solana, so the link goes to the chain, not to us.
function markAddresses(post, approved) {
  for (const entry of approved) {
    const row = element("div", "tp-address");
    row.setAttribute("role", "note");
    const mine = entry.handle === post.handle;
    row.append(
      iconElement("mark", "tp-address-icon"),
      element("strong", null, mine ? "Official address" : `Official address of @${entry.handle.slice(2)}`),
      element("span", "tp-mono", `${entry.address.slice(0, 4)}…${entry.address.slice(-4)}`),
      element("span", "tp-address-how", "approved by fingerprint, recorded on Solana")
    );
    const link = element("a", "tp-card-link", "Check onchain ↗");
    link.href = entry.recordUrl;
    link.target = "_blank";
    link.rel = "noopener";
    row.append(link);
    row.addEventListener("click", (event) => event.stopPropagation());
    post.textElement.after(row);
  }
}

// The mark sits inside X's profile link. Keep X from seeing the pointer arrive on it, or its
// own profile preview opens underneath our card.
function quietHover(mark) {
  for (const type of ["mouseover", "pointerover", "mouseenter", "pointerenter"]) mark.addEventListener(type, (event) => event.stopPropagation());
}

// An unsigned post is a caution; an unsigned post carrying a link is how drainers work.
// A plain unsigned post gets only the struck mark. The notice appears when there is something
// to act on: a link to block, or the owner has reported the account compromised.
function markUnsigned(post, compromised, approved) {
  const links = Array.from(post.textElement.querySelectorAll('a[href^="http"]'));
  const name = "@" + post.handle.slice(2);
  // An address in an unsigned post, that this account's phone never approved: the fake token.
  const strange = post.addresses.filter((address) => !approved.some((entry) => entry.address === address && entry.handle === post.handle));
  const danger = compromised || links.length > 0 || strange.length > 0;
  const label = compromised ? "Account compromised" : "No fingerprint on this post";
  const reason = compromised
    ? `The owner of ${name} reported this account as taken over. This post was not approved on their device.`
    : `${name} approves every post with a fingerprint on their own phone. This one has none, so it may not be from them.`;
  const notice = element("div", "tp-notice tp-notice-danger");
  notice.setAttribute("role", "note");
  const line = element("div", "tp-notice-line");
  line.append(iconElement("alert", "tp-notice-icon"), element("strong", null, label), element("span", "tp-notice-reason", reason));
  notice.append(line);
  if (links.length) {
    const gate = element("div", "tp-notice-gate");
    gate.append(element("span", null, compromised ? "Links in this post are blocked." : "Links are blocked. This is how wallet drainers are posted from hacked accounts."));
    const open = element("button", "tp-notice-open", "Unblock links");
    open.type = "button";
    open.addEventListener("click", (event) => {
      event.stopPropagation();
      notice.dataset.unblocked = "true";
      links.forEach((link) => link.classList.remove("tp-blocked-link"));
      gate.remove();
    });
    gate.append(open);
    notice.append(gate);
    for (const link of links) {
      link.classList.add("tp-blocked-link");
      link.addEventListener(
        "click",
        (event) => {
          if (notice.dataset.unblocked) return;
          event.preventDefault();
          event.stopPropagation();
          gate.classList.remove("tp-flash");
          void gate.offsetWidth; // restart the animation
          gate.classList.add("tp-flash");
        },
        true
      );
    }
  }
  if (strange.length) notice.append(element("div", "tp-notice-gate", `${name}'s phone never approved the address in this post. Do not buy it or send funds to it.`));
  notice.addEventListener("click", (event) => event.stopPropagation());
  if (danger) post.textElement.before(notice);

  const mark = iconElement("unsigned", danger ? "tp-mark tp-mark-unsigned tp-mark-danger" : "tp-mark tp-mark-unsigned");
  mark.setAttribute("role", "img");
  mark.setAttribute("aria-label", label);
  mark.title = `${label}: ${reason}`;
  mark.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  quietHover(mark);
  (post.profileLink.firstElementChild || post.profileLink).append(mark);
}

// The kill switch is about the account, not one post, so the profile itself carries the warning.
let profileChecked = { handle: "", at: 0 };
async function markProfile() {
  const header = document.querySelector('[data-testid="UserName"]');
  const handle = header ? "x:" + location.pathname.split("/")[1].toLowerCase() : "";
  const banner = document.querySelector(".tp-profile-banner");
  if (banner && banner.dataset.handle !== handle) banner.remove();
  if (!header || (profileChecked.handle === handle && Date.now() - profileChecked.at < 3500)) return;
  profileChecked = { handle, at: Date.now() };
  const [result] = (await chrome.runtime.sendMessage({ type: "lookup", items: [{ handle, hash: "" }] }).catch(() => null)) || [];
  const current = document.querySelector(".tp-profile-banner");
  if (!result?.compromised) return current?.remove();
  if (current || !header.isConnected) return;
  const notice = element("div", "tp-notice tp-notice-danger tp-profile-banner");
  notice.dataset.handle = handle;
  notice.setAttribute("role", "alert");
  const line = element("div", "tp-notice-line");
  line.append(
    iconElement("alert", "tp-notice-icon"),
    element("strong", null, "Account compromised"),
    element("span", "tp-notice-reason", `The owner reported from their own Seeker that @${handle.slice(2)} was taken over. Do not trust new posts or links until they recover it.`)
  );
  notice.append(line);
  if (result.reportUrl) {
    const proof = element("div", "tp-notice-reason tp-notice-proof", `Reported ${new Date(result.reportedAt * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}, signed with the owner's fingerprint and recorded on Solana. `);
    const link = element("a", "tp-card-link", "View the signed report ↗");
    link.href = result.reportUrl;
    link.target = "_blank";
    link.rel = "noopener";
    proof.append(link);
    notice.append(proof);
  }
  header.after(notice);
}

let dimUnsigned = false;
chrome.storage?.sync.get({ dimUnsigned: false }).then((settings) => {
  dimUnsigned = settings.dimUnsigned;
  rescanAll();
});
chrome.storage?.onChanged.addListener((changes) => {
  if (changes.dimUnsigned) {
    dimUnsigned = changes.dimUnsigned.newValue;
    rescanAll();
  }
});

function rescanAll() {
  document.querySelectorAll("article[data-tp-key]").forEach((article) => delete article.dataset.tpKey);
  scan();
}

async function scan() {
  applyTheme();
  markProfile();
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
    pending.map(async ({ post }) => ({ handle: post.handle, hash: await sha256Hex(post.text), postedAt: post.postedAt, addresses: post.addresses }))
  );
  let results;
  try {
    results = await chrome.runtime.sendMessage({ type: "lookup", items });
  } catch {
    results = null;
  }
  pending.forEach(({ article, post, key }, index) => {
    if (article.dataset.tpKey !== key) return; // X recycled the node while we waited
    const result = results?.[index];
    if (!result) return delete article.dataset.tpKey; // lookup failed, retry on next scan
    const stamp = key + JSON.stringify(result) + dimUnsigned;
    if (article.dataset.tpStamp === stamp && (result.state === "none" || article.querySelector(".tp-mark"))) return; // nothing changed
    article.dataset.tpStamp = stamp;
    clearMarks(article);
    if (result.state === "certified") markCertified(post, result);
    else if (result.state === "unsigned") markUnsigned(post, result.compromised, result.addresses || []);
    else if (dimUnsigned) article.classList.add("tp-dim");
    if (result.state !== "unsigned") markAddresses(post, result.addresses || []);
  });
}

// ---- Composer ----

// Inside the Thumbprint app the phone signs for the one account it is linked to, and X's mobile
// layout has no profile tab to read a handle from.
const HOSTED = "ThumbprintHost" in globalThis;

function myHandle() {
  if (HOSTED) return "x:linked";
  const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  return profileLink ? "x:" + profileLink.getAttribute("href").slice(1).toLowerCase() : null;
}

function composerText(start) {
  for (let node = start; node; node = node.parentElement) {
    const editor = node.querySelector('[data-testid^="tweetTextarea_"]');
    if (editor) return normalizeText(visibleText(editor));
  }
  return "";
}

// The background worker's request is cut off after 30 seconds, but reading and approving a post
// can take longer. When the direct answer is lost, the approval is picked up from lookup instead.
async function requestApproval(handle, text) {
  const hash = await sha256Hex(text);
  const deadline = Date.now() + 120_000;
  let direct = await chrome.runtime.sendMessage({ type: "approve", handle, text }).catch(() => null);
  while ((!direct || direct.reason === "Server unreachable") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const [found] = (await chrome.runtime.sendMessage({ type: "lookup", items: [{ handle, hash }] }).catch(() => null)) || [];
    if (found?.state === "certified") direct = { ok: true };
  }
  return direct || { ok: false, reason: "Not approved in time" };
}

const BUTTON_STATES = {
  idle: { icon: "mark", label: "", title: "Sign with Thumbprint: approve this post on your Seeker, then post it" },
  waiting: { icon: "spinner", label: "Check your phone", title: "Waiting for approval on your Seeker" },
  done: { icon: "check", label: "Signed", title: "Approved. Posting." },
  error: { icon: "alert", label: "Not signed", title: "" },
};

function setButtonState(button, state, detail) {
  const config = BUTTON_STATES[state];
  button.dataset.state = state;
  button.querySelector(".tp-sign-icon").innerHTML = ICONS[config.icon];
  button.querySelector(".tp-sign-label").textContent = config.label;
  button.title = detail || config.title;
  button.setAttribute("aria-label", detail || config.title);
  button.disabled = state === "waiting";
}

function addComposerButtons() {
  for (const postButton of document.querySelectorAll('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]')) {
    // X wraps Post in a column that fades when the draft is empty; the row around that
    // wrapper is where a sibling control sits level with Post. Post itself is never restyled.
    const wrapper = postButton.parentElement;
    const row = wrapper?.parentElement;
    if (!row || row.querySelector(".tp-sign")) continue;
    const button = element("button", "tp-sign");
    button.type = "button";
    button.setAttribute("aria-live", "polite");
    button.append(element("span", "tp-sign-icon"), element("span", "tp-sign-label"));
    setButtonState(button, "idle");
    button.addEventListener("click", async () => {
      const handle = myHandle();
      const text = composerText(row);
      if (!handle || !text) return;
      setButtonState(button, "waiting");
      const response = await requestApproval(handle, text);
      if (response.ok && composerText(row) !== text) {
        setButtonState(button, "error", "The draft changed after it was approved. Approve it again.");
      } else if (response.ok) {
        setButtonState(button, "done");
        postButton.click();
      } else {
        setButtonState(button, "error", response?.reason || "Not approved");
      }
      setTimeout(() => setButtonState(button, "idle"), 3500);
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
// Signatures and the compromised flag can arrive after a post is on screen, so look again.
setInterval(() => document.visibilityState === "visible" && rescanAll(), 4000);
