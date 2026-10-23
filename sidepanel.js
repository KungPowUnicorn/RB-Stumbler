// Side panel: the whole GUI. Reads settings from chrome.storage, asks the
// service worker to crawl search pages, applies filters locally, shows one
// random survivor.

const $ = (id) => document.getElementById(id);

const PRODUCT_TYPE_CHOICES = [
  "sticker", "t-shirt", "greeting card", "poster", "art print", "phone case",
  "tote bag", "hoodie", "sweatshirt", "notebook", "mug", "hat", "mask",
  "throw pillow", "poster print", "sticker sheet",
];

let settings = null;
let history = [];
let current = null; // the design currently on display
let activeTab = "stumble"; // which tab is on screen, so we know what to redraw
let busy = false;
let busyHeart = false;
let autoTimers = []; // one per enabled auto mode
let toastTimer = null;

// --- feature state -----------------------------------------------------
let affinity = { tags: {}, shops: {} }; // what your hearts have taught us
let moodboard = []; // designs you explicitly kept
let dismissed = []; // seen and turned down on purpose
let lastPool = []; // survivors from the last search, for Reroll
let lastPoolQuery = "";
let undoStack = []; // what was on screen before, for Undo
let lastStats = null; // { found, kept, byReason } from the last search

const RB_MODALS = ["modal"];
function closeAllModals() {
  RB_MODALS.forEach((id) => {
    const el = $(id);
    if (el) el.hidden = true;
  });
}
function anyModalOpen() {
  return RB_MODALS.some((id) => $(id) && !$(id).hidden);
}

// ---------------------------------------------------------------- storage

function applyTheme() {
  const root = document.documentElement;
  let t = settings.theme || "dark";
  if (t === "system") {
    t = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  root.setAttribute("data-theme", t);
  root.setAttribute("data-accent", settings.accent || "mint");
  root.setAttribute("data-font", settings.fontFamily || "system");
  root.setAttribute("data-scale", settings.fontScale || "medium");
}

// v0.4.0 -> v0.5.0. Two storage keys were renamed when "dealt" was purged, and
// history rows carried verdict: "dealt". Copy the old keys and rewrite the
// verdicts once, so an upgrade keeps its history instead of quietly starting
// over. Runs on every boot; after the first run there is nothing left to do.
async function migrateLegacyKeys() {
  try {
    const legacyNames = Object.keys(RB_LEGACY_KEYS || {});
    if (legacyNames.length) {
      const old = await chrome.storage.local.get(legacyNames);
      const move = {};
      const drop = [];
      for (const [from, to] of Object.entries(RB_LEGACY_KEYS)) {
        if (from in old && old[from] !== undefined) {
          if (!(to in old) || old[to] === undefined) move[to] = old[from];
          drop.push(from);
        }
      }
      if (Object.keys(move).length) await chrome.storage.local.set(move);
      // NB: storage.local.set({k: null}) *stores* null, it does not delete.
      // Removing needs remove(), or the old key lingers and this runs forever.
      if (drop.length) await chrome.storage.local.remove(drop);
    }
    if (RB_LEGACY_DROP && RB_LEGACY_DROP.length) {
      await chrome.storage.local.remove(RB_LEGACY_DROP);
    }

    const storedHistory = await chrome.storage.local.get(RB_STORAGE_KEYS.history);
    const rows = storedHistory[RB_STORAGE_KEYS.history];
    if (Array.isArray(rows) && rows.some((h) => h && h.verdict === "dealt")) {
      await chrome.storage.local.set({
        [RB_STORAGE_KEYS.history]: rows.map((h) =>
          h && h.verdict === "dealt" ? Object.assign({}, h, { verdict: "shown" }) : h
        ),
      });
    }
  } catch (err) {
    // Deliberately swallowed: a failed migration must never stop the panel
    // from opening. Note the cost — this also hides programming errors such as
    // reaching for the wrong namespace, which is exactly how a bug in here can
    // go unnoticed. The Firefox test suite runs with `chrome` booby-trapped
    // for precisely this reason.
    console.warn("[RB Stumbler] legacy storage migration skipped:", err);
  }
}

async function loadAll() {
  await migrateLegacyKeys();

  const stored = await chrome.storage.local.get([
    RB_STORAGE_KEYS.settings,
    RB_STORAGE_KEYS.history,
    RB_STORAGE_KEYS.affinity,
    RB_STORAGE_KEYS.moodboard,
    RB_STORAGE_KEYS.dismissed,
    RB_STORAGE_KEYS.lastShown,
  ]);
  settings = Object.assign(
    {},
    RB_DEFAULT_SETTINGS,
    stored[RB_STORAGE_KEYS.settings] || {}
  );
  if (!Array.isArray(settings.queries)) settings.queries = RB_DEFAULT_QUERIES.slice();
  if (!Array.isArray(settings.queriesOff)) settings.queriesOff = [];
  if (!Array.isArray(settings.excludedTags)) settings.excludedTags = [];
  if (!Array.isArray(settings.excludedShops)) settings.excludedShops = [];
  if (!Array.isArray(settings.shopWhitelist)) settings.shopWhitelist = [];
  if (!Array.isArray(settings.productTypes)) settings.productTypes = [];
  history = stored[RB_STORAGE_KEYS.history] || [];
  affinity = stored[RB_STORAGE_KEYS.affinity] || { tags: {}, shops: {} };
  if (!affinity.tags) affinity.tags = {};
  if (!affinity.shops) affinity.shops = {};
  moodboard = stored[RB_STORAGE_KEYS.moodboard] || [];
  dismissed = stored[RB_STORAGE_KEYS.dismissed] || [];
}

async function saveSettings() {
  await chrome.storage.local.set({ [RB_STORAGE_KEYS.settings]: settings });
}

// History is one big array under one storage key. Keep it inside a byte
// budget so a huge history can never blow the storage quota or make every save
// expensive — which is the real ceiling on "as high as possible".
async function saveHistory() {
  let h = history;

  const limit = settings.historyLimit ?? 10000;
  if (limit > 0) h = h.slice(0, limit);

  if (h.length) {
    const json = JSON.stringify(h);
    if (json.length > RB_HISTORY_BYTE_BUDGET) {
      const perEntry = json.length / h.length;
      const keep = Math.max(200, Math.floor(RB_HISTORY_BYTE_BUDGET / perEntry));
      h = h.slice(0, keep);
    }
  }

  history = h;
  await chrome.storage.local.set({ [RB_STORAGE_KEYS.history]: history });
}

// ---------------------------------------------------------------- chrome bits

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4200);
}

function activateTab(name) {
  activeTab = name;
  document.querySelectorAll(".view").forEach((v) => {
    v.hidden = v.dataset.view !== name;
  });
  document.querySelectorAll(".tabs button").forEach((b) => {
    b.classList.toggle("on", b.dataset.tab === name);
  });
  if (name === "history") renderHistory();
  if (name === "moodboard") renderBoard();
  if (name === "queries") renderQueries();
  if (name === "filters") renderFilters();
}

// ---------------------------------------------------------------- queries

function enabledQueries() {
  const off = new Set((settings.queriesOff || []).map((s) => s.toLowerCase()));
  return settings.queries.filter((q) => !off.has(String(q).toLowerCase()));
}

// Shuffle bag: every enabled query gets used once before any repeat.
async function pickQuery() {
  const enabled = enabledQueries();
  if (!enabled.length) return null;

  const stored = await chrome.storage.local.get(RB_STORAGE_KEYS.bag);
  const enabledSet = new Set(enabled);
  let bag = (stored[RB_STORAGE_KEYS.bag] || []).filter((q) => enabledSet.has(q));

  if (!bag.length) {
    bag = enabled.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
  }

  const next = bag.pop();
  await chrome.storage.local.set({ [RB_STORAGE_KEYS.bag]: bag });
  return next;
}

function renderQueries() {
  const ul = $("queryList");
  ul.textContent = "";
  const off = new Set((settings.queriesOff || []).map((s) => s.toLowerCase()));
  // Always shown alphabetically, whatever order they went in.
  const sorted = settings.queries.slice().sort((x, y) => x.localeCompare(y));

  if (!sorted.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No queries yet — add one below.";
    ul.appendChild(li);
    return;
  }

  sorted.forEach((q) => {
    const li = document.createElement("li");
    const on = !off.has(String(q).toLowerCase());

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = on;
    cb.addEventListener("change", async () => {
      const cur = new Set((settings.queriesOff || []).map((s) => s.toLowerCase()));
      if (cb.checked) cur.delete(String(q).toLowerCase());
      else cur.add(String(q).toLowerCase());
      settings.queriesOff = Array.from(cur);
      li.classList.toggle("off", !cb.checked);
      await saveSettings();
    });

    const grow = document.createElement("span");
    grow.className = "grow";
    grow.textContent = q;
    grow.title = q;

    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "✕";
    x.title = "Remove";
    x.addEventListener("click", async () => {
      settings.queries = settings.queries.filter((z) => z !== q);
      await saveSettings();
      renderQueries();
    });

    if (!on) li.classList.add("off");
    li.append(cb, grow, x);
    ul.appendChild(li);
  });
}

async function addQuery(text) {
  const t = (text || "").trim();
  if (!t) return;
  if (!settings.queries.some((q) => q.toLowerCase() === t.toLowerCase())) {
    settings.queries.push(t);
    await saveSettings();
  }
  renderQueries();
}

// ---------------------------------------------------------------- filters

function renderList(target, arr, onRemove) {
  const ul = $(target);
  ul.textContent = "";
  if (!arr.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "none";
    ul.appendChild(li);
    return;
  }
  arr.forEach((item, i) => {
    const li = document.createElement("li");
    const grow = document.createElement("span");
    grow.className = "grow";
    grow.textContent = item;
    grow.title = item;
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "✕";
    x.addEventListener("click", async () => {
      arr.splice(i, 1);
      onRemove();
      await saveSettings();
      renderFilters();
    });
    li.append(grow, x);
    ul.appendChild(li);
  });
}

function renderFilters() {
  $("useTagFilter").checked = !!settings.useTagFilter;
  $("useShopFilter").checked = !!settings.useShopFilter;
  $("useShopWhitelist").checked = !!settings.useShopWhitelist;
  $("useProductTypeFilter").checked = !!settings.useProductTypeFilter;
  $("usePriceFilter").checked = !!settings.usePriceFilter;
  $("useMinTagsFilter").checked = !!settings.useMinTagsFilter;
  $("minPrice").value = settings.minPrice ?? "";
  $("maxPrice").value = settings.maxPrice ?? "";
  $("minTags").value = settings.minTags ?? "";

  renderList("tagList", settings.excludedTags, () => {});
  renderList("shopList", settings.excludedShops, () => {});
  renderList("shopWhitelistList", settings.shopWhitelist, () => {});
  renderList("typeList", settings.productTypes, () => {});

  const sel = $("typeChoices");
  if (sel.options.length === 0) {
    PRODUCT_TYPE_CHOICES.forEach((t) => {
      const o = document.createElement("option");
      o.value = t;
      o.textContent = t;
      sel.appendChild(o);
    });
  }
}

async function addToList(key, inputId, label) {
  const el = $(inputId);
  const t = (el.value || "").trim();
  if (!t) return;
  if (!settings[key].some((x) => x.toLowerCase() === t.toLowerCase())) {
    settings[key].push(t);
    await saveSettings();
  }
  el.value = "";
  renderFilters();
}

// ---------------------------------------------------------------- settings

function numOrNull(id) {
  const raw = $(id).value.trim();
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function renderSettings() {
  $("pages").value = settings.pages;
  $("delayMs").value = settings.delayMs;
  $("searchUrlTemplate").value = settings.searchUrlTemplate || "";
  $("theme").value = settings.theme || "dark";
  $("accent").value = settings.accent || "mint";
  $("fontFamily").value = settings.fontFamily || "system";
  $("fontScale").value = settings.fontScale || "medium";
  $("excludeSeen").checked = !!settings.excludeSeen;
  $("openOnStumble").checked = !!settings.openOnStumble;
  $("openTarget").value = settings.openTarget || "new";
  $("historyLimit").value = settings.historyLimit;
  $("autoToggle").checked = !!settings.autoMode;
  $("autoSeconds").value = settings.autoSeconds;
  $("autoRerollToggle").checked = !!settings.autoRerollMode;
  $("autoRerollSeconds").value = settings.autoRerollSeconds ?? 15;
  $("pickOrder").value = settings.pickOrder || "random";
  $("affinityEnabled").checked = !!settings.affinityEnabled;
  $("affinityStrength").value = settings.affinityStrength || 1;
  renderPickOrderHint();
}

// Built from RB_STUMBLE_ORDER so the dropdown can never list an option the
// picker doesn't actually implement.
function renderPickOrder() {
  const sel = $("pickOrder");
  sel.textContent = "";
  for (const [value, def] of Object.entries(RB_STUMBLE_ORDER)) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = def.label;
    sel.appendChild(opt);
  }
}

const RB_PICK_HINTS = {
  random: "Redbubble's own ranking, shuffled. Every stumble is a coin flip.",
  relevant: "The highest-ranked result Redbubble thinks matches the query.",
  recent: "Whatever was uploaded most recently.",
  topselling: "Whatever is selling most. Safest picks, least surprises.",
  trending: "What Redbubble currently has a spike in.",
  cheapest: "Lowest price across every survivor.",
  priciest: "Highest price across every survivor.",
};

function renderPickOrderHint() {
  const el = $("pickOrderHint");
  if (!el) return;
  el.textContent = RB_PICK_HINTS[settings.pickOrder] || RB_PICK_HINTS.random;
}

function bindSettings() {
  const save = async () => saveSettings();

  $("useTagFilter").addEventListener("change", async (e) => {
    settings.useTagFilter = e.target.checked;
    await save();
  });
  $("useShopFilter").addEventListener("change", async (e) => {
    settings.useShopFilter = e.target.checked;
    await save();
  });
  $("useShopWhitelist").addEventListener("change", async (e) => {
    settings.useShopWhitelist = e.target.checked;
    await save();
  });
  $("useProductTypeFilter").addEventListener("change", async (e) => {
    settings.useProductTypeFilter = e.target.checked;
    await save();
  });
  $("usePriceFilter").addEventListener("change", async (e) => {
    settings.usePriceFilter = e.target.checked;
    await save();
  });
  $("useMinTagsFilter").addEventListener("change", async (e) => {
    settings.useMinTagsFilter = e.target.checked;
    await save();
  });

  // Typing a price is clearly intent to filter by price, so tick it for them.
  const priceChanged = async (e) => {
    const raw = e.target.value.trim();
    settings[e.target.id] = raw === "" ? null : Number(raw);
    if (raw !== "" && !settings.usePriceFilter) {
      settings.usePriceFilter = true;
      $("usePriceFilter").checked = true;
    }
    await save();
  };
  $("minPrice").addEventListener("change", priceChanged);
  $("maxPrice").addEventListener("change", priceChanged);
  $("pages").addEventListener("change", async (e) => {
    settings.pages = Math.min(50, Math.max(1, parseInt(e.target.value || "1", 10)));
    e.target.value = settings.pages;
    await save();
  });
  $("theme").addEventListener("change", async (e) => {
    settings.theme = e.target.value;
    applyTheme();
    await save();
  });
  $("accent").addEventListener("change", async (e) => {
    settings.accent = e.target.value;
    applyTheme();
    await save();
  });
  $("fontFamily").addEventListener("change", async (e) => {
    settings.fontFamily = e.target.value;
    applyTheme();
    await save();
  });
  $("fontScale").addEventListener("change", async (e) => {
    settings.fontScale = e.target.value;
    applyTheme();
    await save();
  });

  $("btnClearQueries").addEventListener("click", async () => {
    if (!settings.queries.length) return toast("There are no queries to clear");
    if (!confirm(`Delete all ${settings.queries.length} queries? You can bring them back with "Restore defaults".`)) return;
    settings.queries = [];
    settings.queriesOff = [];
    await chrome.storage.local.remove(RB_STORAGE_KEYS.bag); // reset the shuffle bag too
    await saveSettings();
    renderQueries();
    toast("All queries cleared");
  });
  $("btnClearFilters").addEventListener("click", async () => {
    const has = settings.excludedTags.length || settings.excludedShops.length ||
      settings.shopWhitelist.length || settings.productTypes.length ||
      settings.minPrice != null || settings.maxPrice != null || settings.minTags != null;
    if (!has) return toast("No filters are set");
    if (!confirm("Clear every filter? Lists emptied, price and tag limits reset, all filter tick boxes off.")) return;
    settings.excludedTags = [];
    settings.excludedShops = [];
    settings.shopWhitelist = [];
    settings.productTypes = [];
    settings.minPrice = null;
    settings.maxPrice = null;
    settings.minTags = null;
    settings.useTagFilter = false;
    settings.useShopFilter = false;
    settings.useShopWhitelist = false;
    settings.useProductTypeFilter = false;
    settings.usePriceFilter = false;
    settings.useMinTagsFilter = false;
    await saveSettings();
    renderFilters();
    toast("All filters cleared");
  });
  $("delayMs").addEventListener("change", async (e) => {
    settings.delayMs = Math.min(60000, Math.max(0, parseInt(e.target.value || "0", 10)));
    e.target.value = settings.delayMs;
    await save();
  });
  $("searchUrlTemplate").addEventListener("change", async (e) => {
    settings.searchUrlTemplate = e.target.value.trim();
    await save();
  });
  $("minTags").addEventListener("change", async (e) => {
    const raw = e.target.value.trim();
    settings.minTags = raw === "" ? null : Number(raw);
    if (raw !== "" && !settings.useMinTagsFilter) {
      settings.useMinTagsFilter = true;
      $("useMinTagsFilter").checked = true;
    }
    await save();
  });
  $("excludeSeen").addEventListener("change", async (e) => {
    settings.excludeSeen = e.target.checked;
    await save();
  });
  $("openOnStumble").addEventListener("change", async (e) => {
    settings.openOnStumble = e.target.checked;
    await save();
  });
  $("openTarget").addEventListener("change", async (e) => {
    settings.openTarget = e.target.value;
    await save();
  });
  $("historyLimit").addEventListener("change", async (e) => {
    settings.historyLimit = Math.min(50000, Math.max(0, parseInt(e.target.value || "0", 10)));
    e.target.value = settings.historyLimit;
    await save();
    await saveHistory();
    renderHistory();
  });

  $("autoSeconds").addEventListener("change", async (e) => {
    settings.autoSeconds = Math.min(600, Math.max(3, parseInt(e.target.value || "15", 10)));
    e.target.value = settings.autoSeconds;
    await save();
    if (settings.autoMode) restartAuto();
  });
  $("autoToggle").addEventListener("change", async (e) => {
    settings.autoMode = e.target.checked;
    await save();
    restartAuto();
  });
  $("autoRerollSeconds").addEventListener("change", async (e) => {
    settings.autoRerollSeconds = Math.min(600, Math.max(3, parseInt(e.target.value || "15", 10)));
    e.target.value = settings.autoRerollSeconds;
    await save();
    if (settings.autoRerollMode) restartAuto();
  });
  $("autoRerollToggle").addEventListener("change", async (e) => {
    settings.autoRerollMode = e.target.checked;
    await save();
    restartAuto();
  });

  // queries / filters inputs
  $("btnAddQuery").addEventListener("click", async () => {
    await addQuery($("newQuery").value);
    $("newQuery").value = "";
  });
  $("newQuery").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btnAddQuery").click();
  });
  $("btnBulkAdd").addEventListener("click", async () => {
    const lines = ($("bulkQueries").value || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (const l of lines) await addQuery(l);
    $("bulkQueries").value = "";
    toast(`Added ${lines.length} quer${lines.length === 1 ? "y" : "ies"}`);
  });
  $("btnAll").addEventListener("click", async () => {
    // If everything is currently ticked, untick everything. Otherwise tick all.
    const allOn = enabledQueries().length === settings.queries.length;
    settings.queriesOff = allOn ? settings.queries.slice() : [];
    await saveSettings();
    renderQueries();
    toast(allOn ? "All queries unticked" : "All queries ticked");
  });
  $("btnRestoreQueries").addEventListener("click", async () => {
    settings.queries = RB_DEFAULT_QUERIES.slice();
    settings.queriesOff = [];
    await saveSettings();
    renderQueries();
    toast(`Restored ${RB_DEFAULT_QUERIES.length} default queries`);
  });

  $("btnSuggestTags").addEventListener("click", async () => {
    let added = 0;
    for (const t of RB_SUGGESTED_TAGS) {
      if (!settings.excludedTags.some((x) => x.toLowerCase() === t.toLowerCase())) {
        settings.excludedTags.push(t);
        added++;
      }
    }
    if (added === 0) return toast("They're all already in the list");
    settings.useTagFilter = true;
    await saveSettings();
    renderFilters();
    toast(`Added ${added} suggested tags`);
  });

  $("btnAddTag").addEventListener("click", () => addToList("excludedTags", "newTag"));
  $("newTag").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btnAddTag").click();
  });
  $("btnAddShop").addEventListener("click", () => addToList("excludedShops", "newShop"));
  $("btnAddShopWhitelist").addEventListener("click", () => addToList("shopWhitelist", "newShopWhitelist"));
  $("newShopWhitelist").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btnAddShopWhitelist").click();
  });
  $("newShop").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btnAddShop").click();
  });
  $("btnAddType").addEventListener("click", async () => {
    const v = $("typeChoices").value;
    if (v && !settings.productTypes.includes(v)) {
      settings.productTypes.push(v);
      await saveSettings();
    }
    renderFilters();
  });

  // data
  $("btnExport").addEventListener("click", () => {
    const payload = {
      app: "rb-stumbler",
      version: 1,
      exportedAt: new Date().toISOString(),
      settings,
      history,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "rb-stumbler-backup.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast(`Exported ${history.length} history entries`);
  });
  $("btnImport").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const parsed = JSON.parse(await f.text());
      // Accept both the backup shape ({settings, history}) and a bare settings file.
      settings = Object.assign({}, RB_DEFAULT_SETTINGS, parsed.settings || parsed);
      if (Array.isArray(parsed.history)) {
        history = parsed.history;
        await saveHistory();
      }
      await saveSettings();
      applyTheme();
      renderSettings();
      renderQueries();
      renderFilters();
      toast("Imported" + (parsed.history ? ` ${history.length} history entries` : ""));
    } catch (_) {
      toast("That file wasn't valid JSON");
    }
    e.target.value = "";
  });
  $("btnResetTab").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "rbstumbler:reset-tab" });
    toast("Search tab will be recreated on next stumble");
  });
  $("btnShowTab").addEventListener("click", async () => {
    const res = await chrome.runtime.sendMessage({ type: "rbstumbler:show-tab" });
    toast(res && res.ok ? "Brought the search tab forward" : "Couldn't find that tab");
  });

  $("btnClearHistory").addEventListener("click", async () => {
    history = [];
    await saveHistory();
    renderHistory();
    toast("History cleared");
  });

  // tabs + buttons
  document.querySelectorAll(".tabs button").forEach((b) => {
    b.addEventListener("click", () => activateTab(b.dataset.tab));
  });
  $("btnStumble").addEventListener("click", stumble);
  $("btnOpen").addEventListener("click", openCurrent);
  $("btnHeart").addEventListener("click", heartCurrent);
  $("btnSave").addEventListener("click", saveCurrent);
  $("btnDismiss").addEventListener("click", dismissCurrent);
  $("btnBlockShop").addEventListener("click", blockCurrentShop);
  $("btnReroll").addEventListener("click", reroll);
  $("btnSimilar").addEventListener("click", similar);
  $("btnUndo").addEventListener("click", undo);

  $("btnExportBoard").addEventListener("click", exportBoard);
  $("btnResetAffinity").addEventListener("click", resetAffinity);

  $("pickOrder").addEventListener("change", async (e) => {
    settings.pickOrder = e.target.value;
    renderPickOrderHint();
    await save();
  });
  $("affinityEnabled").addEventListener("change", async (e) => {
    settings.affinityEnabled = e.target.checked;
    await save();
    toast(settings.affinityEnabled ? "Hearts will steer future stumbles" : "Stumbles stay purely random");
  });
  $("affinityStrength").addEventListener("change", async (e) => {
    settings.affinityStrength = Math.min(5, Math.max(1, parseInt(e.target.value || "1", 10)));
    e.target.value = settings.affinityStrength;
    await save();
  });

  // ---- modals ----
  const MODALS = ["modal"];
  const openModal = (id) => {
    closeAllModals();
    $(id).hidden = false;
  };
  $("linkAbout").addEventListener("click", (e) => {
    e.preventDefault();
    openModal("modal");
  });
  $("btnCloseModal").addEventListener("click", () => closeAllModals());
  MODALS.forEach((id) => {
    $(id).addEventListener("click", (e) => {
      if (e.target === $(id)) closeAllModals();
    });
  });
}

// ---------------------------------------------------------------- filtering

function seenKeys() {
  return new Set(history.map((h) => h.key));
}

function dismissedKeys() {
  return new Set(dismissed.map((d) => d.key || d));
}

// Returns null when the design passes, or a short reason string when it doesn't.
// The reasons are counted so the panel can tell you *why* a search came back empty.
function checkFilters(d, s, seen, gone) {
  if (s.excludeSeen && seen.has(d.key)) return "already seen";
  if (gone.has(d.key)) return "dismissed";

  if (s.useShopFilter && s.excludedShops.length) {
    const a = (d.artist || "").toLowerCase();
    if (s.excludedShops.some((x) => a.includes(String(x).toLowerCase()))) return "blocked shop";
  }

  // Allowlist is checked after the blocklist, so a shop can be on the list and
  // still be vetoed. An empty list never filters — ticking the box before
  // typing anything shouldn't blank out every search.
  if (s.useShopWhitelist && s.shopWhitelist.length) {
    const a = (d.artist || "").trim().toLowerCase();
    if (!a || !s.shopWhitelist.some((x) => String(x).trim().toLowerCase() === a)) {
      return "shop not allowed";
    }
  }

  if (s.useTagFilter && s.excludedTags.length) {
    const hay = ((d.tags || []).join(" ") + " " + (d.title || "") + " " + (d.text || "")).toLowerCase();
    if (s.excludedTags.some((x) => hay.includes(String(x).toLowerCase()))) return "blocked tag";
  }

  if (s.useProductTypeFilter && s.productTypes.length) {
    const t = (d.productType || "").toLowerCase();
    if (!s.productTypes.some((x) => x.toLowerCase() === t)) return "wrong product type";
  }

  if (s.usePriceFilter) {
    if (s.minPrice != null && (d.price == null || d.price < s.minPrice)) return "too cheap (or no price)";
    if (s.maxPrice != null && (d.price == null || d.price > s.maxPrice)) return "too dear (or no price)";
  }

  if (s.useMinTagsFilter && s.minTags != null && (d.tags || []).length < s.minTags) {
    return "not tagged enough";
  }

  return null;
}

function passes(d, s, seen) {
  return checkFilters(d, s, seen, dismissedKeys()) === null;
}

// How much your hearts like this design. 0 = nothing learned about it.
function affinityScore(d) {
  let score = 0;
  const shop = (d.artist || "").toLowerCase();
  if (affinity.shops[shop]) score += affinity.shops[shop] * 2;
  for (const t of d.tags || []) {
    if (affinity.tags[t]) score += affinity.tags[t];
  }
  return score;
}

// Pick from the survivors. Deliberately keeps a random component even when
// affinity is on — a slot machine that always lands on the same spot isn't a
// slot machine.
function pickFrom(pool, s) {
  if (!pool.length) return null;

  const strategy = rbStumbleOrder(s.pickOrder).pick;

  if (strategy === "cheapest") {
    return pool
      .filter((d) => d.price != null)
      .sort((a, b) => a.price - b.price)[0] || pool[0];
  }
  if (strategy === "priciest") {
    return pool
      .filter((d) => d.price != null)
      .sort((a, b) => b.price - a.price)[0] || pool[0];
  }
  // "first" is the top of Redbubble's own ranking — we asked for newest (or
  // top-selling, or trending) and take whatever they put at the top.
  if (strategy === "first") return pool[0];

  if (!s.affinityEnabled) return pool[Math.floor(Math.random() * pool.length)];

  const strength = Number(s.affinityStrength) || 1;
  const weights = pool.map((d) => {
    const boost = affinityScore(d) * 0.25 * strength;
    return Math.exp(boost) * (0.35 + Math.random());
  });
  let total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

// Record a judgement. Hearts teach the model; everything else is just history.
function learnFrom(d, weight) {
  const shop = (d.artist || "").toLowerCase();
  if (shop) affinity.shops[shop] = (affinity.shops[shop] || 0) + weight;
  for (const t of d.tags || []) {
    affinity.tags[t] = (affinity.tags[t] || 0) + weight;
  }
  // Decay, so one big shop doesn't own the model forever.
  for (const k of Object.keys(affinity.shops)) {
    affinity.shops[k] *= 0.995;
    if (affinity.shops[k] < 0.01) delete affinity.shops[k];
  }
  for (const k of Object.keys(affinity.tags)) {
    affinity.tags[k] *= 0.995;
    if (affinity.tags[k] < 0.01) delete affinity.tags[k];
  }
}

// ---------------------------------------------------------------- new actions

function pushUndo() {
  if (!current) return;
  undoStack.push(current);
  if (undoStack.length > 20) undoStack.shift();
}

// Take back the last judgement AND the design itself.
async function undo() {
  if (!undoStack.length) return;
  const back = undoStack.pop();

  // Remove this design from history/dismissed entirely, then put the old one back.
  history = history.filter((h) => h.key !== current?.key);
  await saveHistory();

  if (back.key !== current?.key) {
    history = history.filter((h) => h.key !== back.key);
  }

  lastPool = lastPool.filter((d) => d.key !== back.key);
  current = null;
  showDesign(back);
  // showDesign re-added it to history, which is correct: it was shown before.
  setStatus("Took that back", "");
}

// Another from the search we already ran — no new query, no bag advance.
async function reroll() {
  if (!lastPool.length) return stumble();

  // Drawing from this pool *spends* it: the design on screen leaves the pool
  // before we choose, and the one we choose leaves too.
  //
  // Both halves are load-bearing. Only filtering the outgoing design was
  // enough to avoid handing back the same thing, but the ordered picks —
  // Most relevant, Cheapest first, Priciest first — then oscillated between
  // exactly two designs forever, because the design just left kept returning
  // to the head of the list. Random picks hid it: uniform random over the
  // pool happens to cover everything, so this only ever showed up once
  // Stumble order was anything other than Random.
  if (current) lastPool = lastPool.filter((d) => d.key !== current.key);
  if (!lastPool.length) return toast("Nothing else left in this pool — Stumble for a new search");
  const pick = pickFrom(lastPool, settings);
  lastPool = lastPool.filter((d) => d.key !== pick.key);
  pushUndo();
  showDesign(pick);
  setStatus(`Rerolled — ${lastPool.length} left in that pool`, "");
}

// Follow Redbubble's own "similar designs" from the one on screen.
async function similar() {
  if (!current || busy) return;
  busy = true;
  $("btnSimilar").disabled = true;
  setStatus("Looking for similar designs…", "busy");

  try {
    const res = await chrome.runtime.sendMessage({
      type: "rbstumbler:similar",
      url: current.url,
      excludeUrl: current.url,
    });
    const found = (res && res.designs) || [];
    if (!found.length) {
      setStatus("Couldn't find similar designs on that page.", "err");
      return;
    }
    const seen = seenKeys();
    const gone = dismissedKeys();
    const pool = found.filter((d) => checkFilters(d, settings, seen, gone) === null);
    if (!pool.length) {
      setStatus(`Found ${found.length} similar, but your filters killed them all.`, "err");
      return;
    }
    lastPool = pool;
    lastPoolQuery = "similar to " + (current.title || "previous");
    const pick = pickFrom(pool, settings);
    pushUndo();
    showDesign(pick);
    setStatus(`Rabbit hole — ${pool.length} similar designs`, "");
  } catch (e) {
    setStatus("Couldn't follow similar designs", "err");
  } finally {
    busy = false;
    $("btnSimilar").disabled = !current;
  }
}

// "I don't want to see this shop again" in one tap. The Filters tab is two
// clicks away and needs the name typed in; this is the same action taken from
// the thing that annoyed you.
//
// Two details that matter: the shop filter is switched *on* if it wasn't, or
// the entry would sit in the list doing nothing; and an already-blocked shop
// is reported rather than silently duplicated.
async function blockCurrentShop() {
  if (!current) return;
  const shop = (current.artist || "").trim();
  if (!shop) return toast("No shop name for this one — add it in Filters");

  const already = settings.excludedShops.some(
    (x) => String(x).toLowerCase() === shop.toLowerCase()
  );
  if (!already) {
    settings.excludedShops.push(shop);
    settings.useShopFilter = true;
    await saveSettings();
    renderFilters();
  }

  // It's on screen right now, so leaving it there after saying "not this shop"
  // reads like nothing happened.
  dismissCurrent();

  toast(
    already
      ? `${shop} is already in your filter list`
      : `${shop} added to your filter list — remove it in Filters`,
    ""
  );
}

// Turn this one down for good.
async function dismissCurrent() {
  if (!current) return;
  const gone = current;
  dismissed = dismissed.filter((x) => (x.key || x) !== gone.key);
  dismissed.unshift({ key: gone.key, url: gone.url, title: gone.title, ts: Date.now() });
  if (dismissed.length > 5000) dismissed = dismissed.slice(0, 5000);
  await chrome.storage.local.set({ [RB_STORAGE_KEYS.dismissed]: dismissed });

  lastPool = lastPool.filter((d) => d.key !== gone.key);
  const rest = lastPool.filter((d) => d.key !== gone.key);
  const pick = rest.length ? pickFrom(rest, settings) : null;
  pushUndo();
  if (pick) showDesign(pick);
  else clearDesign();
  setStatus("Dismissed — you won't see it again", "");
}

// Keep this one on your own board, independent of Redbubble's favourites.
async function saveCurrent() {
  if (!current) return;
  if (moodboard.some((m) => m.key === current.key)) {
    toast("Already on your board");
    return;
  }
  moodboard.unshift({
    key: current.key,
    url: current.url,
    title: current.title,
    artist: current.artist,
    image: current.image || null,
    price: current.price == null ? null : current.price,
    query: current.__query || lastPoolQuery || "",
    ts: Date.now(),
  });
  await chrome.storage.local.set({ [RB_STORAGE_KEYS.moodboard]: moodboard });
  resetSave();
  toast("Saved to your board");
  markVerdict("kept");
}

function renderBoard() {
  const grid = $("boardGrid");
  grid.textContent = "";
  $("boardCount").textContent = moodboard.length
    ? `${moodboard.length} design${moodboard.length === 1 ? "" : "s"} kept.`
    : "Nothing saved yet — hit Save to board on anything you like.";

  moodboard.forEach((m) => {
    const card = document.createElement("div");
    card.className = "card-item";

    const link = document.createElement("a");
    link.href = m.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    if (m.image) {
      const img = document.createElement("img");
      img.src = m.image;
      img.alt = "";
      img.loading = "lazy";
      thumb.appendChild(img);
    } else {
      const span = document.createElement("span");
      span.textContent = "no image";
      thumb.appendChild(span);
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = m.title || "(untitled)";
    const a = document.createElement("div");
    a.className = "a";
    a.textContent = m.price != null ? `${m.artist} · $${m.price.toFixed(2)}` : m.artist || "";
    meta.append(t, a);
    link.append(thumb, meta);

    const kill = document.createElement("button");
    kill.className = "kill";
    kill.textContent = "×";
    kill.title = "Remove from board";
    kill.addEventListener("click", async (e) => {
      e.preventDefault();
      moodboard = moodboard.filter((x) => x.key !== m.key);
      await chrome.storage.local.set({ [RB_STORAGE_KEYS.moodboard]: moodboard });
      renderBoard();
    });

    card.append(link, kill);
    grid.appendChild(card);
  });
}

function exportBoard() {
  if (!moodboard.length) return toast("Nothing on the board yet");
  const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const rows = [
    ["title", "artist", "price", "url", "image", "query", "saved"].join(","),
  ];
  for (const m of moodboard) {
    rows.push(
      [m.title, m.artist, m.price == null ? "" : m.price, m.url, m.image, m.query, new Date(m.ts).toISOString()]
        .map(esc)
        .join(",")
    );
  }
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "rb-stumbler-board.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`Exported ${moodboard.length} designs`);
}

async function resetAffinity() {
  affinity = { tags: {}, shops: {} };
  await chrome.storage.local.set({ [RB_STORAGE_KEYS.affinity]: affinity });
  toast("Cleared — it will learn again from scratch");
}

// ---------------------------------------------------------------- helpers

// "48 → 12 · 30 already seen · 6 blocked tag"
function describeReasons(reasons, found, kept) {
  const bits = Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([why, n]) => `${n} ${why}`);
  const head =
    found != null && kept != null ? `${found} found, ${kept} kept` : "nothing kept";
  return bits.length ? `${head} · ${bits.join(" · ")}` : head;
}

function renderFilterNote() {
  const el = $("filterNote");
  if (!el || !lastStats) return;
  const bits = Object.entries(lastStats.byReason || {})
    .sort((a, b) => b[1] - a[1])
    .map(([why, n]) => `${n} ${why}`);
  el.hidden = false;
  // Built with nodes rather than innerHTML. The reason strings come from our
  // own filter code, so this was never injectable — but a template literal
  // assembled from scraped site data is exactly the shape that turns into an
  // XSS bug the day one of these strings stops being ours.
  el.textContent = "";
  const head = document.createElement("b");
  head.textContent = `${lastStats.found} found, ${lastStats.kept} kept.`;
  el.appendChild(head);
  el.appendChild(
    document.createTextNode(
      bits.length ? ` Dropped: ${bits.join(", ")}.` : " Nothing was filtered out."
    )
  );
}

// ------------------------------------------------------------- the design

function showDesign(d) {
  current = d;

  const img = $("previewImg");
  const empty = $("previewEmpty");
  if (d.image) {
    img.src = d.image;
    img.classList.add("show");
    empty.hidden = true;
    img.onerror = () => {
      img.classList.remove("show");
      empty.hidden = false;
      empty.textContent = "Preview image wouldn't load — hit Open";
    };
  } else {
    img.classList.remove("show");
    empty.hidden = false;
    empty.textContent = "No preview image for this one";
  }

  $("dTitle").textContent = d.title || "(untitled)";
  const bits = ["by " + (d.artist || "unknown")];
  if (d.price != null) bits.push("from $" + d.price.toFixed(2));
  if (d.productType) bits.push(d.productType);
  $("dSub").textContent = bits.join(" · ");

  const tagWrap = $("dTags");
  tagWrap.textContent = "";
  (d.tags || []).slice(0, 8).forEach((t) => {
    const s = document.createElement("span");
    s.className = "tag";
    s.textContent = t;
    tagWrap.appendChild(s);
  });

  $("btnOpen").disabled = false;
  // lastPool now holds only designs you haven't been shown yet, so one left
  // is still worth rerolling to. It used to need two, which meant the last
  // design in a pool could never be reached by reroll.
  $("btnReroll").disabled = lastPool.length < 1;
  $("btnSimilar").disabled = false;
  $("btnUndo").disabled = undoStack.length === 0;
  $("btnDismiss").disabled = false;
  // No shop name means nothing to block, so don't offer the button.
  $("btnBlockShop").disabled = !(d.artist || "").trim();
  resetHeart(true);
  resetSave();

  // "Shown" means no explicit verdict — it counts as seen either way.
  const limit = settings.historyLimit ?? 10000;
  history = history.filter((h) => h.key !== d.key);
  history.unshift({
    key: d.key,
    url: d.url,
    title: d.title,
    artist: d.artist,
    image: d.image || null,
    price: d.price == null ? null : d.price,
    ts: Date.now(),
    query: d.__query || lastPoolQuery || "",
    verdict: "shown",
  });
  if (limit > 0) history = history.slice(0, limit);
  saveHistory();

  chrome.storage.local
    .set({ [RB_STORAGE_KEYS.lastShown]: d })
    .catch(() => {});
}

function clearDesign() {
  current = null;
  $("previewImg").classList.remove("show");
  $("previewImg").removeAttribute("src");
  $("previewEmpty").hidden = false;
  $("previewEmpty").textContent = "Press Stumble to draw one";
  $("dTitle").textContent = "—";
  $("dSub").textContent = "—";
  $("dTags").textContent = "";
  $("btnOpen").disabled = true;
  $("btnReroll").disabled = true;
  $("btnSimilar").disabled = true;
  $("btnDismiss").disabled = true;
  $("btnUndo").disabled = undoStack.length === 0;
  resetHeart(false);
  resetSave();
  $("filterNote").hidden = true;
}

function resetSave() {
  const b = $("btnSave");
  if (!b) return;
  const kept = current && moodboard.some((m) => m.key === current.key);
  b.className = kept ? "chip on" : "chip";
  b.disabled = !current;
  $("saveLabel").textContent = kept ? "On your board" : "Save to board";
}

// Tag the design on screen with a verdict, so history can show what you thought.
function markVerdict(verdict) {
  if (!current) return;
  history = history.map((h) =>
    h.key === current.key ? Object.assign({}, h, { verdict }) : h
  );
  saveHistory();
}

// enabled=true only when there is actually a design on screen to heart.
function resetHeart(enabled) {
  const b = $("btnHeart");
  if (!b) return;
  b.className = "heart";
  $("heartLabel").textContent = "Heart it on Redbubble";
  b.disabled = enabled !== true;
}

// Favourites the design on Redbubble itself, using the account you're already
// signed into. One click, one page load - the same thing as clicking the
// heart by hand.
async function heartCurrent() {
  if (!current || busyHeart) return;
  const b = $("btnHeart");
  busyHeart = true;
  b.disabled = true;
  b.className = "heart busy";
  $("heartLabel").textContent = "Hearting…";
  setStatus("Favouriting on Redbubble…", "busy");

  try {
    const res = await chrome.runtime.sendMessage({
      type: "rbstumbler:favorite",
      url: current.url,
    });
    if (res && res.ok) {
      learnFrom(current, 2);
      await chrome.storage.local.set({ [RB_STORAGE_KEYS.affinity]: affinity });
      markVerdict("hearted");
      b.className = "heart on";
      $("heartLabel").textContent = res.already ? "Already hearted" : "Hearted";
      setStatus(res.already ? "Already in your favourites" : "Added to your favourites", "");
    } else {
      const reason = res && res.reason;
      b.className = "heart err";
      b.disabled = false; // let them try again
      $("heartLabel").textContent =
        reason === "not-signed-in"
          ? "Sign in to Redbubble first"
          : reason === "no-heart-on-page"
          ? "Couldn't find the heart"
          : "Couldn't heart it";
      setStatus(
        reason === "not-signed-in"
          ? "Sign in to Redbubble in the search tab, then try again."
          : "Couldn't favourite that design.",
        "err"
      );
    }
  } catch (e) {
    b.className = "heart err";
    $("heartLabel").textContent = "Couldn't heart it";
    setStatus("Favouriting failed", "err");
  } finally {
    busyHeart = false;
  }
}

async function openCurrent() {
  if (!current) return;
  markVerdict("opened");
  await chrome.runtime.sendMessage({ type: "rbstumbler:open", url: current.url, target: settings.openTarget || "new" });
}

async function stumble() {
  if (busy) return;
  busy = true;
  $("btnStumble").disabled = true;
  activateTab("stumble");

  try {
    const query = await pickQuery();
    if (!query) {
      setStatus("No queries ticked — add some in the Queries tab", "err");
      return;
    }

    const sent = query;
    const order = rbStumbleOrder(settings.pickOrder);
    setStatus(`Searching for “${sent}”…`, "busy");

    const res = await chrome.runtime.sendMessage({
      type: "rbstumbler:crawl",
      options: {
        query: sent,
        pages: settings.pages,
        sortOrder: order.sortOrder,
        delayMs: settings.delayMs,
        searchUrlTemplate: settings.searchUrlTemplate,
      },
    });

    if (!res || !res.ok) {
      const reason = (res && res.reason) || "unknown";
      if (reason === "cloudflare") {
        setStatus(
          "Cloudflare showed a challenge — I've brought the search tab forward. Clear it there, then Stumble again.",
          "err"
        );
      } else if (reason === "tab-unavailable") {
        setStatus("Lost the search tab. Hit Stumble again and it'll make a new one.", "err");
      } else if (reason === "empty-results") {
        setStatus(`No results at all for “${sent}” — try a broader query.`, "err");
      } else {
        setStatus("Found the page but no designs in it on that search.", "err");
      }
      return;
    }

    const seen = seenKeys();
    const gone = dismissedKeys();
    const reasons = {};
    const pool = [];
    for (const d of res.designs) {
      const why = checkFilters(d, settings, seen, gone);
      if (why) reasons[why] = (reasons[why] || 0) + 1;
      else pool.push(d);
    }

    lastStats = { found: res.designs.length, kept: pool.length, byReason: reasons };
    renderFilterNote();

    if (!pool.length) {
      clearDesign();
      setStatus(`Nothing survived: ${describeReasons(reasons)}`, "err");
      return;
    }

    lastPool = pool;
    lastPoolQuery = sent;
    const pick = pickFrom(pool, settings);
    pick.__query = sent;
    pushUndo();
    showDesign(pick);
    setStatus(describeReasons(reasons, res.designs.length, pool.length), "");

    if (settings.openOnStumble) {
      await chrome.runtime.sendMessage({
        type: "rbstumbler:open",
        url: pick.url,
        target: settings.openTarget || "new",
      });
    }
  } catch (e) {
    setStatus("Something went wrong: " + (e && e.message ? e.message : e), "err");
  } finally {
    busy = false;
    $("btnStumble").disabled = false;
  }
}

// ---------------------------------------------------------------- auto mode

function restartAuto() {
  for (const t of autoTimers) clearInterval(t);
  autoTimers = [];

  if (settings.autoMode) {
    autoTimers.push(
      setInterval(() => {
        if (!busy) stumble();
      }, Math.max(3, settings.autoSeconds) * 1000)
    );
  }
  if (settings.autoRerollMode) {
    // reroll() walks the pool the current search already returned. When that
    // pool is empty it falls back to stumble() by itself, so this timer can
    // never end up doing nothing.
    autoTimers.push(
      setInterval(() => {
        if (!busy) reroll();
      }, Math.max(3, settings.autoRerollSeconds || 15) * 1000)
    );
  }
}

// ---------------------------------------------------------------- history

// How each query has performed, derived from history — no extra bookkeeping.
function queryStats() {
  const m = {};
  for (const h of history) {
    const q = h.query || "(unknown)";
    if (!m[q]) m[q] = { shown: 0, kept: 0, hearted: 0, opened: 0 };
    m[q].shown++;
    if (h.verdict === "kept") m[q].kept++;
    if (h.verdict === "hearted") m[q].hearted++;
    if (h.verdict === "opened") m[q].opened++;
  }
  return m;
}

function renderHistory() {
  const ul = $("historyList");
  ul.textContent = "";
  const stats = queryStats();

  const total = history.length;
  $("historyCount").textContent = total
    ? `${total} shown${total > RB_HISTORY_DISPLAY_CAP ? ` · showing the newest ${RB_HISTORY_DISPLAY_CAP}` : ""}.`
    : "Nothing drawn yet.";

  if (!total) return;

  const shown = history.slice(0, RB_HISTORY_DISPLAY_CAP);
  shown.forEach((h) => {
    const li = document.createElement("li");

    const wrap = document.createElement("div");
    wrap.className = "hist";

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    if (h.image) {
      const img = document.createElement("img");
      img.src = h.image;
      img.alt = "";
      img.loading = "lazy";
      thumb.appendChild(img);
    }

    const body = document.createElement("div");
    body.className = "body";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = h.title || "(untitled)";
    t.title = (h.artist || "") + (h.price != null ? ` · $${h.price.toFixed(2)}` : "");
    const s = document.createElement("div");
    s.className = "s";
    s.textContent = new Date(h.ts).toLocaleString();
    body.append(t, s);

    wrap.append(thumb, body);

    if (h.verdict && h.verdict !== "shown") {
      const v = document.createElement("span");
      v.className = "verdict";
      v.textContent = h.verdict;
      wrap.appendChild(v);
    }

    if (h.query) {
      const st = document.createElement("span");
      st.className = "stat";
      const rec = stats[h.query];
      st.textContent = rec
        ? `${h.query}: ${rec.shown}${rec.hearted ? " · " + rec.hearted + "♥" : ""}`
        : h.query;
      st.title = rec
        ? `${h.query} — ${rec.shown} shown, ${rec.hearted} hearted, ${rec.opened} opened`
        : h.query;
      wrap.appendChild(st);
    }

    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "✕";
    x.addEventListener("click", async () => {
      history = history.filter((z) => z.key !== h.key);
      await saveHistory();
      renderHistory();
    });
    li.appendChild(wrap);
    li.appendChild(x);
    ul.appendChild(li);
  });
}

// ---------------------------------------------------------------- keys

document.addEventListener("keydown", (e) => {
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;

  if (e.key === "Escape") {
    if (anyModalOpen()) {
      e.preventDefault();
      closeAllModals();
      return;
    }
  }

  // Modal is open — swallow shortcuts rather than stumbling underneath it.
  if (anyModalOpen()) return;

  if (e.key === "Enter") {
    e.preventDefault();
    stumble();
  } else if (e.key === "o" || e.key === "O") {
    openCurrent();
  } else if (e.key === "r" || e.key === "R") {
    if (!$("btnReroll").disabled) reroll();
  } else if (e.key === "s" || e.key === "S") {
    if (!$("btnSimilar").disabled) similar();
  } else if (e.key === "d" || e.key === "D") {
    if (!$("btnDismiss").disabled) dismissCurrent();
  } else if (e.key === "b" || e.key === "B") {
    if (!$("btnSave").disabled) saveCurrent();
  } else if (e.key === "z" || e.key === "Z") {
    if (!$("btnUndo").disabled) undo();
  }
});

// ---------------------------------------------------------------- boot

// ---------------------------------------------------------------- boot

// The hotkey only reaches the background, so it stamps a flag and we pick it
// up here — whether the panel was already open or is being opened right now.
async function consumePendingStumble() {
  try {
    const stored = await chrome.storage.local.get(RB_STORAGE_KEYS.pendingStumble);
    const at = stored[RB_STORAGE_KEYS.pendingStumble];
    if (!at) return;
    await chrome.storage.local.remove(RB_STORAGE_KEYS.pendingStumble);
    if (Date.now() - at > 20000) return; // stale
    if (busy) return;
    await stumble();
  } catch (_) {
    /* nothing pending */
  }
}

(async function boot() {
  await loadAll();
  applyTheme();
  renderPickOrder();
  renderSettings();
  renderQueries();
  renderFilters();
  bindSettings();
  clearDesign();
  restartAuto();

  // Version shown in About comes from the manifest, never from a literal here.
  // It was hardcoded once and shipped a release out of date.
  try {
    const el = $("modalVer");
    if (el && chrome.runtime.getManifest) el.textContent = "v" + chrome.runtime.getManifest().version;
  } catch (_) {
    /* tests stub the namespace without getManifest */
  }

  const n = enabledQueries().length;
  setStatus(n ? `Ready — ${n} quer${n === 1 ? "y" : "ies"} in the hat` : "Add some queries first");

  // Put back whatever was on screen when the panel was last closed.
  const stored = await chrome.storage.local.get(RB_STORAGE_KEYS.lastShown);
  const back = stored[RB_STORAGE_KEYS.lastShown];
  if (back && back.url) {
    showDesign(back);
    setStatus("Picked up where you left off");
  }

  // Alt+Shift+S works whether or not the panel was already open.
  await consumePendingStumble();

  // Let settings edited in another window stay in sync.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (changes[RB_STORAGE_KEYS.settings]) {
      await loadAll();
      applyTheme();
      renderSettings();
      renderQueries();
      renderFilters();
    }
    if (changes[RB_STORAGE_KEYS.pendingStumble]) consumePendingStumble();
    if (changes[RB_STORAGE_KEYS.history] && activeTab === "history") renderHistory();
    if (changes[RB_STORAGE_KEYS.moodboard] && activeTab === "moodboard") renderBoard();
  });
})();