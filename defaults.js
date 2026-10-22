// Shared defaults. Loaded by both the service worker (importScripts) and the
// side panel (<script> tag).
//
// Every option is optional: null / [] / false means "no constraint", so the
// thing works with an empty config.

const RB_DEFAULT_QUERIES = [
  "abstract",
  "anti design",
  "baroque",
  "bauhaus",
  "boho line art",
  "botanical",
  "cassette futurism",
  "cats",
  "coquette",
  "cottagecore",
  "cyberpunk",
  "dark academia",
  "dark botanical",
  "dark fantasy",
  "dreamcore",
  "fairycore",
  "glitchcore",
  "goblincore",
  "gothic illustration",
  "grunge aesthetic",
  "hyperpop",
  "japanese art",
  "kawaii art",
  "liminal space",
  "linocut",
  "lofi",
  "mid century modern",
  "minimalist",
  "pixel art",
  "pop art",
  "psychedelic",
  "retro gaming",
  "retrofuturism",
  "scandi minimalist",
  "showa retro",
  "solarpunk",
  "space",
  "steampunk",
  "surrealism",
  "synthwave",
  "tarot art",
  "vaporwave",
  "vector wave",
  "vintage anime",
  "vintage celestial",
  "vintage japan",
  "weirdcore",
  "whimsigoth",
  "witchcore",
  "y2k aesthetic",];

// The excluded-tag list starts EMPTY on purpose. This is only offered as a
// one-click preset, because everyone's idea of slop is different.
//
// These deliberately do NOT block "liminal space" or "weirdcore", even
// though both are default queries — blocking a term you also search for
// means that search returns nothing that survives the filter.
const RB_SUGGESTED_TAGS = [
  "digital download",
  "png bundle",
  "svg mockup",
  "mockup",
  "clipart",
  "instant download",
  "printable file",
  "ai generated",
  "midjourney",
  "wallpaper bundle",
  "8k resolution",
  "trending on artstation",
  "hyperrealistic",
  "octane render",
  "unreal engine 5",
  "photorealistic",
  "masterpiece",
  "cinematic lighting",
  "ultra detailed",
  "4k wallpaper",
  "ai art",
  "digital art",
  "aesthetic",
  "epic fantasy",
  "concept art",
  "dark aesthetic",
  "vibrant colors",
  "cool design",
  "trending art",
  "futuristic",
  "midjourney v6",
  "stable diffusion",
  "dall-e 3",
  "prompt art",
  "aspect ratio 16:9",
  "photorealism",
  "seed 42",
  "raw photo",
  "cinematic view",
  "ai generated meme",
  "gigachad",
  "brainrot",
  "sigmacore",
  "cursed image",
  "surreal meme",
  "ai cat",
  "cool gift",
  "gift for him",
  "gift for her",
  "trendy sticker",
  "unique art",
  "wall art",
  "funny shirt",
  "best seller",
  "graphic tee",
  "generative art",
  "created with midjourney",
];

// History is stored as one array under one storage key. Big is fine until the
// serialised blob gets expensive to rewrite on every deal — this budget keeps
// it well inside chrome.storage's quota no matter what the user sets.
const RB_HISTORY_BYTE_BUDGET = 4 * 1024 * 1024; // 4 MB
const RB_HISTORY_DISPLAY_CAP = 300; // never render 10k <li> into the panel

const RB_DEFAULT_SETTINGS = {
  // --- appearance -----------------------------------------------------
  theme: "dark", // dark | light | system
  accent: "mint", // mint | sky | rose | amber | violet
  fontFamily: "system", // system | sans | serif | mono | rounded
  fontScale: "medium", // small | medium | large | xlarge

  // --- queries ---------------------------------------------------------
  queries: RB_DEFAULT_QUERIES.slice(),
  queriesOff: [],

  // --- filters (each list has an independent master toggle) -------------
  useTagFilter: false,
  excludedTags: [], // starts empty — use the preset button if you want one
  useShopFilter: false,
  excludedShops: [],
  useProductTypeFilter: false,
  productTypes: [],
  usePriceFilter: false,
  useMinTagsFilter: false,
  minTags: null, // null = don't care how many tags a design has
  minPrice: null, // null = no minimum
  maxPrice: null, // null = no maximum

  // --- how it searches --------------------------------------------------
  // Blank = use the built-in URL. If Redbubble changes how search URLs are
  // built, paste the correct shape here using {query}, {page} and {sort}.
  searchUrlTemplate: "",
  pages: 1, // how many result pages to crawl for a bigger random pool
  delayMs: 1200, // pause between page loads. Keep this human.

  // --- how a design is picked from the survivors ------------------------
  // Key into RB_STUMBLE_ORDER. Drives BOTH the sort Redbubble returns AND
  // which survivor we hand you — see the table for why they're one setting.
  pickOrder: "random",
  affinityEnabled: false, // let your hearts bias future stumbles
  affinityStrength: 1,

  // --- behaviour --------------------------------------------------------
  excludeSeen: true,
  openOnStumble: false, // off = preview it in the panel first, then you hit Open
  openTarget: "new", // new = a new tab, same = replace whatever tab you're on
  autoMode: false,
  autoSeconds: 15,
  historyLimit: 10000,
};

// How the next design gets chosen. This used to be two separate settings —
// "Sort" in the Search section and "Deal order" in Dealing — which made it
// look like you had to pick twice. It isn't: asking Redbubble for newest
// results and then picking the newest one is a single decision, so it's a
// single dropdown now.
//
//   sortOrder → goes in the Redbubble search URL (they rank the page)
//   pick      → what we do with the survivors we scraped off that page
//
// "first" means the top of Redbubble's own ranking, which is why the four
// Redbubble-side orders all take index 0. The two price ones have no
// Redbubble equivalent, so they ask for the normal ranking and sort locally.
const RB_STUMBLE_ORDER = {
  random: { label: "Random", sortOrder: "relevant", pick: "random" },
  relevant: { label: "Most relevant", sortOrder: "relevant", pick: "first" },
  recent: { label: "Most recent", sortOrder: "recent", pick: "first" },
  topselling: { label: "Top selling", sortOrder: "top selling", pick: "first" },
  trending: { label: "Trending", sortOrder: "trending", pick: "first" },
  cheapest: { label: "Cheapest first", sortOrder: "relevant", pick: "cheapest" },
  priciest: { label: "Priciest first", sortOrder: "relevant", pick: "priciest" },
};

// Old settings stored "popular" for sort, which Redbubble never accepted —
// there is no such sort. Anything unrecognised falls back to Random rather
// than silently picking from an unfiltered page.
function rbStumbleOrder(key) {
  return RB_STUMBLE_ORDER[key] || RB_STUMBLE_ORDER.random;
}

const RB_STORAGE_KEYS = {
  settings: "rbstumbler_settings",
  history: "rbstumbler_history",
  bag: "rbstumbler_bag",
  tabId: "rbstumbler_worker_tab",
  affinity: "rbstumbler_affinity", // { tags: {token: n}, shops: {name: n} }
  moodboard: "rbstumbler_moodboard", // designs you explicitly kept
  dismissed: "rbstumbler_dismissed", // seen and turned down on purpose
  lastDeal: "rbstumbler_last_deal", // so the panel reopens on what you had
  pendingDeal: "rbstumbler_pending_deal", // timestamp set by the hotkey
};