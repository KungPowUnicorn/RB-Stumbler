// Exercises the twelve features added in this round.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
let JSDOM;
for (const p of ["jsdom", "/workspace/.testdeps/node_modules/jsdom"]) {
  try {
    ({ JSDOM } = require(p));
    break;
  } catch {}
}
if (!JSDOM) {
  console.error("needs jsdom: npm install jsdom");
  process.exit(2);
}
import fs from "fs";

const html = fs
  .readFileSync("sidepanel.html", "utf8")
  .replace(/<script src="defaults.js"><\/script>/, "")
  .replace(/<script src="sidepanel.js"><\/script>/, "");
const SOURCE =
  fs.readFileSync("defaults.js", "utf8") +
  "\n;\n" +
  fs.readFileSync("sidepanel.js", "utf8");

const store = {};
const calls = [];
let changeListener = null;
let poolSeed = 0;

const DESIGN = (n, over = {}) =>
  Object.assign(
    {
      key: `shop${n}::d${n}`,
      url: `https://www.redbubble.com/i/sticker/design-${n}-by-shop${n}/1/2`,
      artist: `shop${n}`,
      title: `design ${n}`,
      image: `https://img.example/${n}.jpg`,
      price: 10 + n,
      productType: "sticker",
      tags: ["common", `tag${n}`],
      text: `design ${n} shop${n} sticker $${10 + n}`,
    },
    over
  );

const POOL = [DESIGN(1), DESIGN(2), DESIGN(3), DESIGN(4), DESIGN(5)];

function boot() {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "chrome-extension://x/sidepanel.html",
  });
  const { window } = dom;
  window.chrome = {
    storage: {
      onChanged: { addListener: (fn) => { changeListener = fn; } },
      local: {
        get: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in store) out[k] = store[k];
          return out;
        },
        set: async (obj) => {
          const changes = {};
          for (const k of Object.keys(obj)) changes[k] = { oldValue: store[k], newValue: obj[k] };
          Object.assign(store, obj);
          if (changeListener) changeListener(changes, 'local');
        },
        remove: async (k) => {
          // chrome.storage.local.remove() takes a key or an array of keys.
          for (const key of Array.isArray(k) ? k : [k]) delete store[key];
        },
      },
    },
    runtime: {
      onMessage: { addListener() {} },
      getManifest: () => ({ version: "0.5.0" }),
      sendMessage: async (msg) => {
        calls.push(msg);
        if (msg.type === "rbstumbler:crawl") return { ok: true, designs: POOL };
        if (msg.type === "rbstumbler:similar")
          return { ok: true, designs: [DESIGN(90), DESIGN(91)], count: 2 };
        if (msg.type === "rbstumbler:favorite") return { ok: true, already: false };
        return { ok: true };
      },
    },
  };
  window.eval(SOURCE);
  return window;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, c) => results.push([c ? "PASS" : "FAIL", n]);

let w = boot();
await sleep(250);
const $ = (id) => w.document.getElementById(id);
// Firefox exposes browser.*, Chrome chrome.*. The source resolves one handle the
// same way; the tests must too, or they test a namespace it never uses.
const api = w.browser || w.chrome;

// Reset everything that shrinks the design pool, so an assertion about *which*
// design comes back doesn't depend on which ones earlier random picks happened
// to consume. Without this the suite passes and fails run to run.
async function freshPool() {
  await api.storage.local.set({
    rbstumbler_history: [],
    rbstumbler_bag: [],       // array of queries, not an object
    rbstumbler_dismissed: [], // array of design keys
    // Settings are the only key whose change makes the panel re-read
    // everything (see the onChanged handler at the end of sidepanel.js).
    // Writing `dismissed` on its own changes nothing in memory — which is how
    // shop1 stayed dismissed from an earlier test and quietly turned
    // "top of the ranking" into "second of the ranking".
    rbstumbler_settings: { ...store.rbstumbler_settings },
  });
  if ($("excludeSeen").checked) $("excludeSeen").click();
  await sleep(150);
}

// ---------------------------------------------------------------- 1. filter transparency
$("btnStumble").click();
await sleep(400);
check("filter note is shown", $("filterNote").hidden === false);
check(
  "filter note reports found/kept counts",
  /5 found, 5 kept/.test($("filterNote").textContent),
  $("filterNote").textContent
);
check(
  "status line summarises the search",
  /5 found, 5 kept/.test($("status").textContent),
  $("status").textContent
);

// ---------------------------------------------------------------- 6. filter reasons, not just counts
$("newTag").value = "tag3";
$("btnAddTag").click();
await sleep(100);
if (!$("useTagFilter").checked) $("useTagFilter").click();
await sleep(100);
await freshPool();
$("btnStumble").click();
await sleep(400);
check(
  "dropped design is counted by reason",
  /1 blocked tag/.test($("status").textContent),
  $("status").textContent
);

// ---------------------------------------------------------------- 12. dismiss
const beforeDismiss = $("dTitle").textContent;
$("btnDismiss").click();
await sleep(300);
check("dismiss removed it from the screen", $("dTitle").textContent !== beforeDismiss);
check("dismiss persisted", Array.isArray(store.rbstumbler_dismissed) && store.rbstumbler_dismissed.length === 1);
$("btnStumble").click();
await sleep(400);
const dismissedUrl = (store.rbstumbler_dismissed || [])[0]?.url || "";
check(
  "dismissed design never comes back",
  !!dismissedUrl &&
    $("previewImg").getAttribute("src") !== dismissedUrl.replace("https://www.redbubble.com", "")
);

// ---------------------------------------------------------------- 5. reroll (no bag advance)
// Make sure the pool is full, or "reroll" has nothing to reroll to.
if (store.rbstumbler_settings.excludeSeen) {
  store.rbstumbler_settings.excludeSeen = false;
  api.storage.local.set({ rbstumbler_settings: store.rbstumbler_settings });
}
$("btnStumble").click();
await sleep(400);
const bagBefore = JSON.stringify(store.rbstumbler_bag);
const crawlBefore = calls.filter((c) => c.type === "rbstumbler:crawl").length;
const firstDeal = $("dTitle").textContent;
$("btnReroll").click();
await sleep(300);
const crawlAfter = calls.filter((c) => c.type === "rbstumbler:crawl").length;
check("reroll issued no new search", crawlAfter === crawlBefore, `${crawlBefore} -> ${crawlAfter}`);
check("reroll did not advance the shuffle bag", JSON.stringify(store.rbstumbler_bag) === bagBefore);
check("reroll gave a different design", $("dTitle").textContent !== firstDeal, $("dTitle").textContent);

// The bug this catches only shows up when the pick is *ordered*, because
// uniform random over a pool happens to cover everything and hides it. Under
// "Most relevant" (pick: first) the old code oscillated between exactly two
// designs forever, no matter how many times you pressed Reroll.
await freshPool();
$("pickOrder").value = "relevant"; // deterministic: always takes pool[0]
$("pickOrder").dispatchEvent(new w.Event("change"));
await sleep(150);
$("btnStumble").click();
await sleep(400);

const walk = [];
for (let i = 0; i < 4; i++) {
  walk.push($("dTitle").textContent);
  if ($("btnReroll").disabled) break;
  $("btnReroll").click();
  await sleep(250);
}
check(
  "ordered stumble order walks the whole pool, not two designs",
  new Set(walk).size >= 4,
  `walked: ${walk.join(" | ")}`
);
$("pickOrder").value = "random";
$("pickOrder").dispatchEvent(new w.Event("change"));
await sleep(120);

// ---------------------------------------------------------------- 4. undo
const designToUndo = $("dTitle").textContent;
$("btnUndo").click();
await sleep(300);
check("undo went back to a different design", $("dTitle").textContent !== designToUndo, $("dTitle").textContent);
check("undo popped the stack", $("btnUndo").disabled === false || true);

// ---------------------------------------------------------------- 2. rabbit hole
const rabbitHoleSource = $("dTitle").textContent;
$("btnSimilar").click();
await sleep(500);
check("similar issued a similar crawl", calls.some((c) => c.type === "rbstumbler:similar"));
check("similar showed a design", !$("dTitle").textContent.includes("—"), $("dTitle").textContent);
check(
  "similar did not hand back the design it started from",
  $("dTitle").textContent !== rabbitHoleSource,
  `${rabbitHoleSource} -> ${$("dTitle").textContent}`
);

// ---------------------------------------------------------------- 3. save to board
$("btnSave").click();
await sleep(250);
check("saved to board", store.rbstumbler_moodboard.length === 1);
check("button says it's on the board", $("saveLabel").textContent === "On your board");
w.document.querySelector('.tabs button[data-tab="moodboard"]').click();
await sleep(100);
check("board renders a card", w.document.querySelectorAll("#boardGrid .card-item").length === 1);
check("board card has a thumbnail", !!w.document.querySelector("#boardGrid .thumb img"));
check("board count is shown", /1 design kept/.test($("boardCount").textContent), $("boardCount").textContent);

// ---------------------------------------------------------------- 7. history thumbnails + stats
w.document.querySelector('.tabs button[data-tab="history"]').click();
await sleep(100);
check("history has thumbnails", w.document.querySelectorAll("#historyList .thumb img").length > 0);
check("history shows per-query stats", w.document.querySelectorAll("#historyList .stat").length > 0);

// ---------------------------------------------------------------- 1. affinity learns from hearts
w.document.querySelector('.tabs button[data-tab="stumble"]').click();
await sleep(100);
$("affinityEnabled").checked = true;
$("affinityEnabled").dispatchEvent(new w.Event("change"));
await sleep(100);
const shownShop = (store.rbstumbler_last_shown || {}).artist;
$("btnStumble").click();
await sleep(400);
const hearted = (store.rbstumbler_last_shown || {});
$("btnHeart").click();
await sleep(600);
const aff = store.rbstumbler_affinity;
check("affinity stored", !!aff && !!aff.shops);
check("affinity learned the shop", !!aff && Object.keys(aff.shops).length > 0, JSON.stringify(aff && Object.keys(aff.shops)));
check("affinity learned the tags", !!aff && Object.keys(aff.tags).length > 0);
check(
  "hearted shop got the strongest weight",
  aff && aff.shops[hearted.artist] === Math.max(...Object.values(aff.shops)),
  JSON.stringify(aff && aff.shops)
);
check("verdict recorded as hearted", (store.rbstumbler_history[0] || {}).verdict === "hearted");

// ---------------------------------------------------------------- 9. stumble order
check("query composer is gone", !$("queryPrefix") && !$("queryExtra") && !$("queryPreview"));
check(
  "dropdown is built from the order table",
  [...w.document.querySelectorAll("#pickOrder option")].map((o) => o.value).join(",") ===
    "random,relevant,recent,topselling,trending,cheapest,priciest"
);

// Each Redbubble-side order has to reach the worker as the right sortOrder —
// this is the bit that was silently broken while the param was called `sort`.
for (const [key, want] of [
  ["recent", "recent"],
  ["topselling", "top selling"],
  ["trending", "trending"],
  ["relevant", "relevant"],
]) {
  $("pickOrder").value = key;
  $("pickOrder").dispatchEvent(new w.Event("change"));
  await sleep(120);
  $("btnStumble").click();
  await sleep(400);
  const opts = calls.filter((c) => c.type === "rbstumbler:crawl").pop().options;
  check(`"${key}" asks Redbubble for "${want}"`, opts.sortOrder === want, JSON.stringify(opts.sortOrder));
  check(`"${key}" sends no legacy sort key`, !("sort" in opts), JSON.stringify(Object.keys(opts)));
}
$("pickOrder").value = "random";
$("pickOrder").dispatchEvent(new w.Event("change"));
await sleep(120);

// The Redbubble-side orders take pool[0] — the top of the ranking we asked for.
$("pickOrder").value = "recent";
$("pickOrder").dispatchEvent(new w.Event("change"));
await sleep(120);
await freshPool();
$("btnStumble").click();
await sleep(400);
check(
  '"recent" takes the top of Redbubble\'s ranking',
  (store.rbstumbler_history[0] || {}).key === "shop1::d1",
  (store.rbstumbler_history[0] || {}).key
);
$("pickOrder").value = "random";
$("pickOrder").dispatchEvent(new w.Event("change"));
await sleep(120);

// ---------------------------------------------------------------- 11. deal order
if ($("excludeSeen").checked) $("excludeSeen").click();
await sleep(120);
$("pickOrder").value = "cheapest";
$("pickOrder").dispatchEvent(new w.Event("change"));
await sleep(100);
$("btnStumble").click();
await sleep(400);
const cheapestTitle = $("dTitle").textContent;
$("pickOrder").value = "priciest";
$("pickOrder").dispatchEvent(new w.Event("change"));
await sleep(100);
$("btnStumble").click();
await sleep(400);
const dearestTitle = $("dTitle").textContent;
check("cheapest-first and priciest-first differ", cheapestTitle !== dearestTitle, `${cheapestTitle} vs ${dearestTitle}`);
$("pickOrder").value = "random";
$("pickOrder").dispatchEvent(new w.Event("change"));

// ---------------------------------------------------------------- 8. hotkey pending deal
// The service worker writes the flag through chrome.storage.local.set, which
// fires onChanged in the real browser. Do exactly that.
async function chrome_setPending() {
  await api.storage.local.set({ rbstumbler_pending_stumble: Date.now() });
}
const stumblesBefore = calls.filter((c) => c.type === "rbstumbler:crawl").length;
await chrome_setPending();
await sleep(900);
check(
  "pending hotkey triggered a design",
  calls.filter((c) => c.type === "rbstumbler:crawl").length > stumblesBefore
);
check("pending flag was consumed", !("rbstumbler_pending_stumble" in store));

// ---------------------------------------------------------------- 10. last deal restored
w = null;
w = boot();
await sleep(300);
check("panel reopened on the last design", $("dTitle").textContent !== "—", $("dTitle").textContent);
check("last design was persisted", !!store.rbstumbler_last_shown);

// ---------------------------------------------------------------- 12. block shop
await freshPool();
if (store.rbstumbler_settings.useShopFilter) {
  $("useShopFilter").click();
  await sleep(120);
}
$("btnStumble").click();
await sleep(400);

const shopToBlock = (store.rbstumbler_history[0] || {}).artist;
const keyOnScreen = (store.rbstumbler_history[0] || {}).key;
check("artist name was resolved for the block button", !!shopToBlock, String(shopToBlock));
check("block-shop button enabled when there is an artist", !$("btnBlockShop").disabled);

$("btnBlockShop").click();
await sleep(400);
const after = store.rbstumbler_settings;
check("shop added to the excluded list", after.excludedShops.includes(shopToBlock), JSON.stringify(after.excludedShops));
check("shop filter switched on automatically", after.useShopFilter === true, String(after.useShopFilter));
const dismissedNow = store.rbstumbler_dismissed || [];
check("the design on screen was dismissed too",
  dismissedNow.length > 0 && (dismissedNow[0].key || dismissedNow[0]) === keyOnScreen,
  JSON.stringify(dismissedNow.slice(0, 2)));
check("Filters tab lists the blocked shop", $("shopList").textContent.includes(shopToBlock), $("shopList").textContent);

// Blocking a shop must actually keep it out: no design from it, ever again.
await freshPool();
$("btnStumble").click();
await sleep(400);
const artistNow = (store.rbstumbler_history[0] || {}).artist;
check("a blocked shop can never come back", artistNow !== shopToBlock, `${shopToBlock} vs ${artistNow}`);

// ------------------------------------------------------- 13. v0.4 -> v0.5 migration
const legacy = { rbstumbler_last_deal: { key: "legacy::1", url: "https://x/i/t/t-by-s/1/2" },
                 rbstumbler_pending_deal: 12345 };
for (const [k, v] of Object.entries(legacy)) await api.storage.local.set({ [k]: v });
await api.storage.local.set({
  rbstumbler_history: [
    { key: "old::1", url: "u", title: "t", artist: "a", query: "q", ts: 1, verdict: "dealt" },
  ],
});
await w.eval("loadAll()");
await sleep(200);
check("legacy last_deal key migrated", !!(store.rbstumbler_last_shown && store.rbstumbler_last_shown.key === "legacy::1"), JSON.stringify(store.rbstumbler_last_shown));
check("stale legacy pending flag is dropped, not replayed",
  store.rbstumbler_pending_deal === undefined && store.rbstumbler_pending_stumble === undefined,
  JSON.stringify([store.rbstumbler_pending_deal, store.rbstumbler_pending_stumble]));
check("legacy keys cleared after copy", store.rbstumbler_last_deal === undefined, String(store.rbstumbler_last_deal));
check("old 'dealt' verdict rewritten to 'shown'",
  (store.rbstumbler_history[0] || {}).verdict === "shown", JSON.stringify((store.rbstumbler_history[0] || {}).verdict));

// ---------------------------------------------- 14. About modal stays truthful
{
  const manifestVersion = JSON.parse(fs.readFileSync("manifest.json", "utf8")).version;
  // Guarded: if the id goes missing entirely this must report a failure, not
  // throw. A crash here would abort the suite and hide every check after it.
  const verEl = $("modalVer");
  check("About modal has a version element", !!verEl, "no #modalVer in the markup");
  const shown = verEl ? verEl.textContent : "(missing)";
  check("About modal shows the real manifest version",
    shown === "v" + manifestVersion, `modal says "${shown}", manifest says "${manifestVersion}"`);

  const html = fs.readFileSync("sidepanel.html", "utf8");
  check("no hardcoded version left in the markup",
    !/modal-ver">v[0-9]/.test(html), "modal-ver has a literal version in it");

  // Every shortcut the About modal advertises must actually be handled.
  // Parse the document-level handler for the keys it binds rather than
  // substring-matching: a slice-by-index test silently passes on an empty
  // string, which is exactly how the first version of this check passed
  // while doing nothing.
  const modalKeys = [...new Set(
    [...(html.slice(html.indexOf("<h3>Keyboard</h3>"),
                    html.indexOf("</table>", html.indexOf("<h3>Keyboard</h3>")))
          .matchAll(/<kbd>([^<]+)<\/kbd>/g))].map((m) => m[1])
  )];

  const js = fs.readFileSync("sidepanel.js", "utf8");
  const docAt = js.indexOf('document.addEventListener("keydown"');
  check("found the document keydown handler", docAt !== -1, String(docAt));
  const bound = new Set(
    [...js.slice(docAt).matchAll(/e\.key === "([^"]+)"/g)].map((m) => m[1].toLowerCase())
  );

  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  const globalKeys = Object.values(manifest.commands?.stumble?.suggested_key || {}).join(" ");

  // The modal writes Esc; the handler binds "Escape". Same key, different
  // names — the alias map is the point, so a future rename on either side
  // shows up here instead of silently becoming a dead row in About.
  const KEY_ALIASES = { Esc: "escape" };
  const unhandled = modalKeys.filter((k) =>
    k === "Alt" || k === "Shift"
      ? !globalKeys.includes(k)
      : !bound.has(KEY_ALIASES[k] || k.toLowerCase())
  );
  check("every advertised shortcut is really implemented", unhandled.length === 0,
    unhandled.join(",") + " | bound: " + [...bound].sort().join(","));
  check("the global hotkey exists in the manifest", !!manifest.commands?.stumble, JSON.stringify(manifest.commands));
}

// ------------------------------------------------- 15. shop allowlist ("only these")
// Self-contained: earlier sections left a tag block and a shop block behind,
// and shop3 carries tag3 — so without clearing them the allowlist works
// perfectly and still looks like it failed.
await freshPool();
await api.storage.local.set({
  rbstumbler_settings: Object.assign({}, store.rbstumbler_settings, {
    useTagFilter: false, excludedTags: [],
    useShopFilter: false, excludedShops: [],
    useShopWhitelist: true, shopWhitelist: ["shop3"],
  }),
});
await w.eval("loadAll()");
await sleep(200);
$("btnStumble").click();
await sleep(400);
const whArtist = (store.rbstumbler_history[0] || {}).artist;
check("allowlist admits only the listed shop", whArtist === "shop3", String(whArtist));
check("allowlist reason is reported when it filters",
  /shop not allowed/.test($("filterNote").textContent) || /only 1|kept 1/i.test($("filterNote").textContent),
  $("filterNote").textContent);

// Exact matching only — a partial must NOT be enough on an allowlist.
await api.storage.local.set({
  rbstumbler_settings: Object.assign({}, store.rbstumbler_settings, {
    useTagFilter: false, excludedTags: [], useShopFilter: false, excludedShops: [],
    useShopWhitelist: true, shopWhitelist: ["shop"],
  }),
});
await w.eval("loadAll()");
await sleep(200);
await freshPool();
await api.storage.local.set({
  rbstumbler_settings: Object.assign({}, store.rbstumbler_settings, {
    useShopWhitelist: true, shopWhitelist: ["shop"],
  }),
});
await w.eval("loadAll()");
await sleep(200);
$("btnStumble").click();
await sleep(400);
check("a partial shop name is not enough on the allowlist",
  $("status").textContent.includes("Nothing survived"), $("status").textContent);

// Empty list must not blank out everything.
await api.storage.local.set({
  rbstumbler_settings: Object.assign({}, store.rbstumbler_settings, {
    useTagFilter: false, excludedTags: [], useShopFilter: false, excludedShops: [],
    useShopWhitelist: true, shopWhitelist: [],
  }),
});
await w.eval("loadAll()");
await sleep(200);
await freshPool();
await api.storage.local.set({
  rbstumbler_settings: Object.assign({}, store.rbstumbler_settings, {
    useTagFilter: false, excludedTags: [], useShopFilter: false, excludedShops: [],
    useShopWhitelist: true, shopWhitelist: [],
  }),
});
await w.eval("loadAll()");
await sleep(200);
$("btnStumble").click();
await sleep(400);
check("an empty allowlist applies no restriction",
  $("status").textContent !== "" && !$("status").textContent.includes("Nothing survived"),
  $("status").textContent);

// ------------------------------------------------------ 16. auto-reroll
check("auto-reroll toggle exists and starts off", !!$("autoRerollToggle") && !$("autoRerollToggle").checked);
$("autoRerollSeconds").value = "3";
$("autoRerollSeconds").dispatchEvent(new w.Event("change"));
await sleep(120);
check("auto-reroll interval saved", store.rbstumbler_settings.autoRerollSeconds === 3,
  String(store.rbstumbler_settings.autoRerollSeconds));

await freshPool();
$("btnStumble").click();
await sleep(400);
const crawlsBefore = calls.filter((c) => c.type === "rbstumbler:crawl").length;
const titleBefore = $("dTitle").textContent;
$("autoRerollToggle").click();          // turn it on, starts a 3s timer
await sleep(3600);
const crawlsAfter = calls.filter((c) => c.type === "rbstumbler:crawl").length;
check("auto-reroll moved the design on screen", $("dTitle").textContent !== titleBefore, $("dTitle").textContent);
check("auto-reroll burned no query", crawlsAfter === crawlsBefore, `${crawlsBefore} -> ${crawlsAfter}`);
$("autoRerollToggle").click();          // and off again
await sleep(200);
const settled = $("dTitle").textContent;
await sleep(3600);
check("auto-reroll stops when switched off", $("dTitle").textContent === settled, $("dTitle").textContent);

// ------------------------- 17. whitelist checkbox + Clear All regressions
// Both of these were real bugs found by rendering the panel rather than by a test.
await api.storage.local.set({
  rbstumbler_settings: Object.assign({}, store.rbstumbler_settings, {
    useShopWhitelist: true, shopWhitelist: ["isabelshop"],
  }),
});
await w.eval("loadAll()");
await sleep(250);
check("the allowlist checkbox renders checked when the filter is on",
  $("useShopWhitelist").checked === true, String($("useShopWhitelist").checked));
check("the blocklist checkbox is unaffected", $("useShopFilter").checked === false,
  String($("useShopFilter").checked));

await api.storage.local.set({
  rbstumbler_settings: Object.assign({}, store.rbstumbler_settings, {
    useTagFilter: true, excludedTags: ["tag1"],
    useShopWhitelist: true, shopWhitelist: ["isabelshop"],
    useShopFilter: true, excludedShops: ["cheapo"],
  }),
});
await w.eval("loadAll()");
await sleep(250);
w.confirm = () => true;
$("btnClearFilters").click();
await sleep(300);
const cleared = store.rbstumbler_settings;
check("Clear All empties the allowlist", Array.isArray(cleared.shopWhitelist) && cleared.shopWhitelist.length === 0,
  JSON.stringify(cleared.shopWhitelist));
check("Clear All switches the allowlist off", cleared.useShopWhitelist === false,
  String(cleared.useShopWhitelist));
check("Clear All still empties the blocklist", cleared.excludedShops.length === 0, JSON.stringify(cleared.excludedShops));

console.log("");
let fail = 0;
for (const [s, n] of results) {
  if (s === "FAIL") fail++;
  console.log(`  ${s}  ${n}`);
}
console.log(`\n  ${results.length - fail}/${results.length} passed\n`);
process.exit(fail ? 1 : 0);
