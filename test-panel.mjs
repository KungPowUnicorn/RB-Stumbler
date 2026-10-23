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

const dom = new JSDOM(html, {
  runScripts: "outside-only",
  url: "chrome-extension://x/sidepanel.html",
});
const { window } = dom;

const store = {};
const calls = [];

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
      calls.push(msg);
      if (msg.type === "rbstumbler:crawl") {
        // A different design each time — excludeSeen is on, so repeating one
        // would (correctly) filter the whole pool out.
        const n = (calls.filter((c) => c.type === "rbstumbler:crawl").length) || 1;
        return {
          ok: true,
          designs: [
            {
              key: `shop::design${n}`,
              url: `https://www.redbubble.com/i/sticker/design-${n}-by-isabel/136/9x`,
              artist: "isabel",
              title: `cat mom ${n}`,
              image: null,
              price: 2.66,
              productType: "sticker",
              tags: ["cat", "mom"],
              text: "cat mom sticker by isabel $2.66",
            },
          ],
        };
      }
      if (msg.type === "rbstumbler:favorite") return { ok: true, already: false };
      return { ok: true };
    },
  },
};

// Both files in one scope, exactly like the two <script> tags do.
window.eval(
  fs.readFileSync("defaults.js", "utf8") +
    "\n;\n" +
    fs.readFileSync("sidepanel.js", "utf8")
);

const $ = (id) => window.document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(200);

const results = [];
const check = (name, cond) => results.push([cond ? "PASS" : "FAIL", name]);

check("heart disabled at boot (nothing on screen yet)", $("btnHeart").disabled === true);
check("open disabled at boot", $("btnOpen").disabled === true);

$("btnStumble").click();
await sleep(400);

check("a design is on screen", $("dTitle").textContent.startsWith("cat mom"));
check(
  "artist resolved, no '(unknown artist)'",
  !$("dSub").textContent.includes("unknown artist")
);
check("shows 'by isabel'", $("dSub").textContent.startsWith("by isabel"));
check("OPEN enabled after showing a design", $("btnOpen").disabled === false);
check("HEART enabled after showing a design", $("btnHeart").disabled === false);
check(
  "heart label correct",
  $("heartLabel").textContent === "Heart it on Redbubble"
);

$("btnStumble").click();
await sleep(400);
check("HEART still enabled after a re-show", $("btnHeart").disabled === false);

check("Skip is gone", !$("btnSkip"), "btnSkip still exists in the markup");
check(
  "Dismiss and Block shop are marked destructive",
  $("btnDismiss").className.includes("danger") && $("btnBlockShop").className.includes("danger"),
  $("btnDismiss").className + " / " + $("btnBlockShop").className
);
check(
  "Block shop tooltip points at the filter list",
  /filter list/i.test($("btnBlockShop").getAttribute("title") || ""),
  $("btnBlockShop").getAttribute("title")
);


$("btnHeart").click();
await sleep(600);
check("favourite request actually sent", calls.some((c) => c.type === "rbstumbler:favorite"));
check("heart label shows Hearted", $("heartLabel").textContent === "Hearted");
check("heart styled as done", $("btnHeart").className.includes("on"));

console.log("");
let fail = 0;
for (const [s, n] of results) {
  if (s === "FAIL") fail++;
  console.log(`  ${s}  ${n}`);
}
console.log(`\n  ${results.length - fail}/${results.length} passed\n`);
process.exit(fail ? 1 : 0);