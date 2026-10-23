// Simulates a browser restart: writes settings, throws the window away,
// builds a fresh one, and checks everything came back.
// Resolve jsdom from wherever it happens to live, with a helpful message
// rather than a bare module-not-found if it isn't installed.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
let JSDOM;
for (const p of [
  "jsdom",
  "/workspace/.testdeps/node_modules/jsdom",
  "/tmp/node_modules/jsdom",
]) {
  try {
    ({ JSDOM } = require(p));
    break;
  } catch {}
}
if (!JSDOM) {
  console.error(
    "These tests need jsdom.\n" +
      "  npm install jsdom   (or put it at /workspace/.testdeps)\n" +
      "They are dev-only - the extension itself has no dependencies."
  );
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

// This survives between "launches" - stands in for chrome.storage.local.
const store = {};

function boot() {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "chrome-extension://x/sidepanel.html",
  });
  const { window } = dom;
  window.chrome = {
    storage: {
      onChanged: { addListener() {} },
      local: {
        get: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in store) out[k] = store[k];
          return out;
        },
        set: async (obj) => Object.assign(store, obj),
        remove: async (k) => {
          delete store[k];
        },
      },
    },
    runtime: {
      onMessage: { addListener() {} },
      getManifest: () => ({ version: "0.5.0" }),
      sendMessage: async (msg) => {
        if (msg.type === "rbstumbler:crawl")
          return {
            ok: true,
            designs: [
              {
                key: "shop::d" + Math.floor(Math.random() * 1e9),
                url: "https://www.redbubble.com/i/sticker/x-by-ink/1/2",
                artist: "ink",
                title: "x",
                image: null,
                price: 20, // inside the 12-40 filter this test sets below
                productType: "sticker",
                tags: ["a"],
                text: "x",
              },
            ],
          };
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

// ---------- launch 1: the user configures everything ----------
let w = boot();
await sleep(200);
const $ = (id) => w.document.getElementById(id);

$("newQuery").value = "my custom query";
$("btnAddQuery").click();
await sleep(80);

$("newTag").value = "my blocked tag";
$("btnAddTag").click();
await sleep(80);

$("newShop").value = "bannedshop";
$("btnAddShop").click();
await sleep(80);

$("useTagFilter").click();
$("minPrice").value = "12";
$("minPrice").dispatchEvent(new w.Event("change"));
$("maxPrice").value = "40";
$("maxPrice").dispatchEvent(new w.Event("change"));

$("theme").value = "light";
$("theme").dispatchEvent(new w.Event("change"));
$("accent").value = "violet";
$("accent").dispatchEvent(new w.Event("change"));
$("fontFamily").value = "serif";
$("fontFamily").dispatchEvent(new w.Event("change"));
$("fontScale").value = "large";
$("fontScale").dispatchEvent(new w.Event("change"));

$("pages").value = "7";
$("pages").dispatchEvent(new w.Event("change"));
$("pickOrder").value = "recent";
$("pickOrder").dispatchEvent(new w.Event("change"));
$("excludeSeen").click();
$("historyLimit").value = "2500";
$("historyLimit").dispatchEvent(new w.Event("change"));

// show something so history gets written
$("btnStumble").click();
await sleep(400);

// untick the 2nd default query
const boxes = [...w.document.querySelectorAll("#queryList input[type=checkbox]")];
boxes[1].click();
await sleep(100);

check("settings written to storage", !!store.rbstumbler_settings);
check("history written to storage", Array.isArray(store.rbstumbler_history) && store.rbstumbler_history.length > 0);
check("shuffle bag written to storage", Array.isArray(store.rbstumbler_bag));

// simulate a crash: drop the window entirely
w = null;

// ---------- launch 2: fresh window, same storage ----------
w = boot();
await sleep(250);
const D = (id) => w.document.getElementById(id);

const s = store.rbstumbler_settings;
check("custom query survived", s.queries.includes("my custom query"));
check("50 default queries still there", s.queries.length === 51, `got ${s.queries.length}`);
check("custom tag survived", s.excludedTags.includes("my blocked tag"));
check("custom shop survived", s.excludedShops.includes("bannedshop"));
check("tag filter toggle stayed on", s.useTagFilter === true);
check("price min survived", s.minPrice === 12);
check("price max survived", s.maxPrice === 40);
check("theme survived (light)", s.theme === "light");
check("accent survived (violet)", s.accent === "violet");
check("font survived (serif/large)", s.fontFamily === "serif" && s.fontScale === "large");
check("pages survived (7)", s.pages === 7);
check("stumble order survived (recent)", s.pickOrder === "recent");
check("excludeSeen toggle survived (now off)", s.excludeSeen === false);
check("history size survived (2500)", s.historyLimit === 2500);
check("unticked query stayed unticked", s.queriesOff.length === 1);

// and the UI was repopulated from storage, not left blank
check("UI shows the custom query", [...w.document.querySelectorAll("#queryList .grow")].some((e) => e.textContent === "my custom query"));
check("UI shows light theme applied", w.document.documentElement.getAttribute("data-theme") === "light");
check("UI shows violet accent applied", w.document.documentElement.getAttribute("data-accent") === "violet");
check("UI shows serif font applied", w.document.documentElement.getAttribute("data-font") === "serif");
check("UI price fields repopulated", D("minPrice").value === "12" && D("maxPrice").value === "40");
check("UI history repopulated", store.rbstumbler_history.length === 1);
check("queries still listed alphabetically", (() => {
  const t = [...w.document.querySelectorAll("#queryList .grow")].map((e) => e.textContent);
  return JSON.stringify(t) === JSON.stringify([...t].sort((a, b) => a.localeCompare(b)));
})());

console.log("");
let fail = 0;
for (const [st, n] of results) {
  if (st === "FAIL") fail++;
  console.log(`  ${st}  ${n}`);
}
console.log(`\n  ${results.length - fail}/${results.length} passed\n`);
process.exit(fail ? 1 : 0);