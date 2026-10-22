// Service worker: owns the one dedicated tab it uses to run searches, walks the
// requested pages, and asks the content script what's on them.
//
// It never fetches anything itself. Every request is an ordinary browser
// navigation by an ordinary tab, which is exactly what browsing already looks
// like to the site.

importScripts("defaults.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- side panel

function enablePanelOnClick() {
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  } catch (_) {}
}
chrome.runtime.onInstalled.addListener(enablePanelOnClick);
chrome.runtime.onStartup.addListener(enablePanelOnClick);
enablePanelOnClick();

// ------------------------------------------------------------- worker tab

async function ensureWorkerTab() {
  const stored = await chrome.storage.local.get(RB_STORAGE_KEYS.tabId);
  const id = stored[RB_STORAGE_KEYS.tabId];
  if (typeof id === "number") {
    try {
      await chrome.tabs.get(id);
      return id;
    } catch (_) {
      /* tab was closed; fall through and make a new one */
    }
  }
  const tab = await chrome.tabs.create({ url: "https://www.redbubble.com/", active: false });
  await chrome.storage.local.set({ [RB_STORAGE_KEYS.tabId]: tab.id });
  return tab.id;
}

async function getWorkerTabId() {
  const stored = await chrome.storage.local.get(RB_STORAGE_KEYS.tabId);
  return typeof stored[RB_STORAGE_KEYS.tabId] === "number" ? stored[RB_STORAGE_KEYS.tabId] : null;
}

// ------------------------------------------------------------- url building

function buildSearchUrl(query, page, sortOrder, template) {
  const tpl = (template || "").trim();
  if (tpl) {
    try {
      return tpl
        .replace(/\{query\}/g, encodeURIComponent(query))
        .replace(/\{page\}/g, String(page))
        .replace(/\{sort\}/g, encodeURIComponent(sortOrder || "relevant"));
    } catch (_) {
      /* fall through to the built-in default */
    }
  }
  // No trailing slash: /shop/?query=… redirects to /shop?query=…, and skipping
  // that redirect saves a navigation per page.
  //
  // The param is sortOrder, not sort — Redbubble ignores `sort=` and falls
  // back to relevance, which looks like your choice quietly doing nothing.
  const u = new URL("https://www.redbubble.com/shop");
  u.searchParams.set("query", query);
  u.searchParams.set("sortOrder", sortOrder || "relevant");
  if (page > 1) u.searchParams.set("page", String(page));
  return u.toString();
}

// ------------------------------------------------------------- messaging tab

async function sendTo(tabId, type, extra) {
  return chrome.tabs.sendMessage(tabId, Object.assign({ type }, extra || {}));
}

async function sendScrape(tabId, attempts) {
  let last = { ok: false, reason: "not-attempted", designs: [] };
  for (let i = 0; i < (attempts || 8); i++) {
    try {
      const res = await sendTo(tabId, "rbstumbler:scrape", { timeoutMs: 6000 });
      if (res && res.ok && res.designs && res.designs.length) return res;
      if (res) last = res;
      // A Cloudflare wall won't clear on its own — stop early and surface the tab.
      if (res && res.reason === "cloudflare") return res;
    } catch (e) {
      // Content script not alive yet (still navigating / interstitial showing).
      last = { ok: false, reason: String(e && e.message ? e.message : e), designs: [] };
    }
    await sleep(900);
  }
  return last;
}

// -------------------------------------------------------------------- crawl

async function crawl(options) {
  const { query, pages = 1, sortOrder = "relevant", delayMs = 1200, searchUrlTemplate } = options || {};

  if (!query) return { ok: false, reason: "no-query", designs: [] };

  const tabId = await ensureWorkerTab();
  const all = [];
  const errors = [];
  const seenKeys = new Set();

  for (let page = 1; page <= Math.max(1, pages); page++) {
    const url = buildSearchUrl(query, page, sortOrder, searchUrlTemplate);
    try {
      await chrome.tabs.update(tabId, { url, active: false });
    } catch (_) {
      return { ok: false, reason: "tab-unavailable", designs: [] };
    }

    await sleep(1500); // let the navigation actually start
    const res = await sendScrape(tabId, 8);

    if (res && res.ok && res.designs && res.designs.length) {
      for (const d of res.designs) {
        if (!seenKeys.has(d.key)) {
          seenKeys.add(d.key);
          all.push(d);
        }
      }
    } else if (page === 1) {
      errors.push({ page, reason: (res && res.reason) || "no-results" });
    }

    // If Cloudflare blocked us, bring the tab forward so it can be clicked
    // through, and stop rather than hammering the wall.
    if (res && res.reason === "cloudflare") {
      try {
        await chrome.tabs.update(tabId, { active: true });
        await chrome.windows.update((await chrome.tabs.get(tabId)).windowId, { focused: true });
      } catch (_) {}
      return {
        ok: false,
        reason: "cloudflare",
        designs: [],
        message:
          "Cloudflare put up a challenge. I've brought the search tab to the front — clear it there, then Stumble again.",
      };
    }

    if (page < pages) await sleep(Math.max(0, delayMs));
  }

  if (!all.length) {
    return {
      ok: false,
      reason: (errors[0] && errors[0].reason) || "no-results",
      designs: [],
    };
  }

  return { ok: true, designs: all, pages: Math.max(1, pages) };
}

// ---------------------------------------------------------------- favourite

async function favorite(url) {
  if (!url) return { ok: false, reason: "no-url" };

  const tabId = await ensureWorkerTab();
  try {
    await chrome.tabs.update(tabId, { url, active: false });
  } catch (_) {
    return { ok: false, reason: "tab-unavailable" };
  }

  // Product pages are heavy. Wait for the content script to come alive, then
  // wait for the heart to actually exist, rather than firing a click at a page
  // that hasn't finished rendering.
  let signedIn = true;
  let ready = false;

  for (let i = 0; i < 14; i++) {
    await sleep(700);
    let probe;
    try {
      probe = await chrome.tabs.sendMessage(tabId, { type: "rbstumbler:find-heart" });
    } catch (_) {
      continue; // content script still waking up
    }
    if (!probe) continue;
    signedIn = probe.signedIn !== false;
    if (probe.found) {
      ready = true;
      break;
    }
  }

  if (!ready) {
    return {
      ok: false,
      reason: signedIn ? "no-heart-on-page" : "not-signed-in",
    };
  }

  try {
    return await chrome.tabs.sendMessage(tabId, { type: "rbstumbler:favorite" });
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

// ------------------------------------------------------------ rabbit hole

// Open a design and read back everything else the page links to. Redbubble's
// "similar designs" are ordinary product links, so the same product-URL test
// finds them without needing to know what that section is called.
async function similarTo(url, excludeUrl) {
  if (!url) return { ok: false, reason: "no-url", designs: [] };

  const tabId = await ensureWorkerTab();
  try {
    await chrome.tabs.update(tabId, { url, active: false });
  } catch (_) {
    return { ok: false, reason: "tab-unavailable", designs: [] };
  }

  let last = null;
  for (let i = 0; i < 10; i++) {
    await sleep(800);
    try {
      const res = await chrome.tabs.sendMessage(tabId, {
        type: "rbstumbler:similar",
        excludeUrl: excludeUrl || url,
      });
      if (res && res.ok && res.designs && res.designs.length) return res;
      last = res;
    } catch (_) {
      /* content script still waking up */
    }
  }
  return last && last.ok
    ? last
    : { ok: false, reason: "no-similar-found", designs: [] };
}

// ------------------------------------------------------- global hotkey

// The command fires with only the background awake; the panel may not even be
// open. Stamp a flag and let the panel pick it up whenever it next loads.
chrome.commands && chrome.commands.onCommand.addListener((cmd) => {
  if (cmd !== "stumble") return;
  chrome.storage.local.set({ [RB_STORAGE_KEYS.pendingDeal]: Date.now() }).catch(() => {});
  try {
    chrome.sidePanel.open({}).catch(() => {});
  } catch (_) {
    /* no window focused; the flag will still be picked up */
  }
});

// ----------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "rbstumbler:crawl") {
    crawl(msg.options)
      .then(sendResponse)
      .catch((e) =>
        sendResponse({
          ok: false,
          reason: String(e && e.message ? e.message : e),
          designs: [],
        })
      );
    return true;
  }

  if (msg && msg.type === "rbstumbler:similar") {
    similarTo(msg.url, msg.excludeUrl)
      .then(sendResponse)
      .catch((e) =>
        sendResponse({ ok: false, reason: String(e && e.message ? e.message : e), designs: [] })
      );
    return true;
  }

  if (msg && msg.type === "rbstumbler:favorite") {
    favorite(msg.url)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, reason: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg && msg.type === "rbstumbler:show-tab") {
    (async () => {
      const id = await ensureWorkerTab();
      try {
        await chrome.tabs.update(id, { active: true });
        await chrome.windows.update((await chrome.tabs.get(id)).windowId, { focused: true });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  if (msg && msg.type === "rbstumbler:open") {
    (async () => {
      try {
        if (msg.target === "same") {
          // Replace whatever tab the user is currently looking at.
          const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (active && active.id !== undefined) {
            await chrome.tabs.update(active.id, { url: msg.url, active: true });
          } else {
            await chrome.tabs.create({ url: msg.url, active: true });
          }
        } else {
          await chrome.tabs.create({ url: msg.url, active: true });
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  if (msg && msg.type === "rbstumbler:reset-tab") {
    chrome.storage.local.remove(RB_STORAGE_KEYS.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg && msg.type === "rbstumbler:ping") {
    getWorkerTabId().then(
      (tabId) => sendResponse({ ok: true, tabId }),
      () => sendResponse({ ok: true, tabId: null })
    );
    return true;
  }
});