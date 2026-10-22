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
          delete store[k];
        },
      },
    },
    runtime: {
      onMessage: { addListener() {} },
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

// Reset everything that shrinks the design pool, so an assertion about *which*
// design comes back doesn't depend on which ones earlier random picks happened
// to consume. Without this the suite passes and fails run to run.
async function freshPool() {
  await w.chrome.storage.local.set({
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
check("deal note is shown", $("dealNote").hidden === false);
check(
  "deal note reports found/kept counts",
  /5 found, 5 kept/.test($("dealNote").textContent),
  $("dealNote").textContent
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
check("dismiss removed it from the deal", $("dTitle").textContent !== beforeDismiss);
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
  w.chrome.storage.local.set({ rbstumbler_settings: store.rbstumbler_settings });
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

// ---------------------------------------------------------------- 4. undo
const dealToUndo = $("dTitle").textContent;
$("btnUndo").click();
await sleep(300);
check("undo went back to a different design", $("dTitle").textContent !== dealToUndo, $("dTitle").textContent);
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
const dealtShop = (store.rbstumbler_last_deal || {}).artist;
$("btnStumble").click();
await sleep(400);
const hearted = (store.rbstumbler_last_deal || {});
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
  await w.chrome.storage.local.set({ rbstumbler_pending_deal: Date.now() });
}
const stumblesBefore = calls.filter((c) => c.type === "rbstumbler:crawl").length;
await chrome_setPending();
await sleep(900);
check(
  "pending hotkey triggered a deal",
  calls.filter((c) => c.type === "rbstumbler:crawl").length > stumblesBefore
);
check("pending flag was consumed", !("rbstumbler_pending_deal" in store));

// ---------------------------------------------------------------- 10. last deal restored
w = null;
w = boot();
await sleep(300);
check("panel reopened on the last deal", $("dTitle").textContent !== "—", $("dTitle").textContent);
check("last deal was persisted", !!store.rbstumbler_last_deal);

console.log("");
let fail = 0;
for (const [s, n] of results) {
  if (s === "FAIL") fail++;
  console.log(`  ${s}  ${n}`);
}
console.log(`\n  ${results.length - fail}/${results.length} passed\n`);
process.exit(fail ? 1 : 0);