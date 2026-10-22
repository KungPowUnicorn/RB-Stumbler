// Runs on redbubble.com. Two jobs:
//   1. read whatever search results are on screen and return tidy designs
//
// Design note (v3): the earlier versions assumed product links look like
// /shops/{shop}/designs/{slug}. They don't any more. So we no longer depend on
// the URL shape at all — we take the href as-is, and identify product cards by
// the one thing that is always true of them: they wrap an image. Artist, price,
// product type and tags all come out of the card's own text.

(() => {
  // Opportunistic only — used to *enrich* records, never to decide what a card is.
  const SHOP_PATH = /redbubble\.com\/shops\/([^/?#]+)(?:\/([^/?#]+))?/i;

  // The current product URL shape, which carries the artist in the path:
  //   /i/{product-type}/{Design-Title-by-Artist}/{designId}/{skuId}
  // This is by far the most reliable thing on the card, so it leads.
  const PRODUCT_URL = /redbubble\.com\/i\/([^/?#]+)\/([^/?#]+)\//i;

  function fromDesignUrl(href) {
    const out = { shop: null, slug: null, title: null, productType: null };

    let m = PRODUCT_URL.exec(href || "");
    if (m) {
      out.productType = decodeURIComponent(m[1]).replace(/-/g, " ");
      const seg = decodeURIComponent(m[2]);
      // Everything after the LAST "-by-" is the artist, so a design whose own
      // title contains "by" (e.g. "stand-by-me") still parses correctly.
      const parts = seg.split(/-by-/i);
      if (parts.length > 1) {
        out.shop = parts[parts.length - 1];
        const slug = parts.slice(0, -1).join("-by-");
        out.slug = slug;
        out.title = clean(slug.replace(/-/g, " "));
      } else {
        out.slug = seg;
        out.title = clean(seg.replace(/-/g, " "));
      }
      return out;
    }

    // Legacy shape: /shops/{shop}/designs/{slug}
    m = /redbubble\.com\/shops\/([^/?#]+)(?:\/designs\/([^/?#]+))?/i.exec(href || "");
    if (m) {
      try {
        out.shop = decodeURIComponent(m[1]) || null;
        if (m[2]) {
          out.slug = decodeURIComponent(m[2]);
          out.title = clean(out.slug.replace(/-\d{5,}$/, "").replace(/-/g, " "));
        }
      } catch (_) {}
    }
    return out;
  }

  const PRODUCT_TYPES = [
    "sticker sheet", "sticker", "t-shirt", "greeting card", "poster print",
    "art print", "poster", "phone case", "tote bag", "hoodie", "sweatshirt",
    "notebook", "mug", "hat", "mask", "throw pillow",
  ];

  // ---------------------------------------------------------------- helpers

  function clean(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  function isChrome(el) {
    return !!el.closest(
      "header, nav, footer, [role='banner'], [role='navigation'], [role='contentinfo'], noscript, script, " +
        // Redbubble's footer trust badges (Worldwide Shipping, Secure Payment)
        // are image links to the help centre and would otherwise look like
        // product cards.
        "[class*='TrustSignal' i], [data-testid*='trust' i]"
    );
  }

  // Only the shop itself. help.redbubble.com is a different host, and its
  // footer links are not designs.
  const PRODUCT_HOSTS = new Set(["redbubble.com", "www.redbubble.com"]);

  function hostOf(href) {
    try {
      return new URL(href, location.href).host.toLowerCase();
    } catch (_) {
      return "";
    }
  }

  // Does this href actually point at a product page? Now that Redbubble's URL
  // shape is known, this is a far sharper test than "the link has an image in
  // it" — every badge, promo and footer link on the page also has an image.
  function looksLikeProductUrl(href) {
    if (!href || !PRODUCT_HOSTS.has(hostOf(href))) return false;
    return (
      /redbubble\.com\/i\/[^/?#]+\/[^/?#]+\/\d+/i.test(href) ||
      /redbubble\.com\/shops\/[^/?#]+\/designs\//i.test(href)
    );
  }

  // A 1x1 base64 placeholder is lazy-loading machinery, never the product photo.
  function isPlaceholderImage(src) {
    return !src || /^data:/i.test(src) || /blank|placeholder|spacer/i.test(src);
  }

  // A product card: any link that contains an image, or that sits inside
  // something that looks like a card/tile/result tile.
  function isProductLink(a) {
    // Redbubble tags its own result cards; trust that before anything else.
    if (a.closest("[data-testid*='product-card' i], [data-testid*='search-result' i]")) return true;
    if (a.querySelector("img, picture, [style*='background-image']")) return true;
    const cardish = a.closest(
      "[class*='card' i], [class*='tile' i], [class*='result' i], [class*='product' i], li, article"
    );
    if (cardish && cardish.querySelector("img")) return true;
    return false;
  }

  function findCard(el) {
    let node = el;
    for (let i = 0; i < 8 && node && node !== document.body; i++) {
      if (node.querySelector && node.querySelector("img")) return node;
      node = node.parentElement;
    }
    return el;
  }

  function pickImage(card) {
    const imgs = Array.from(card.querySelectorAll("img")).filter(
      (i) => !isPlaceholderImage(i.currentSrc || i.getAttribute("src"))
    );
    if (!imgs.length) return null;
    const scored = imgs
      .map((i) => ({
        i,
        score: (i.naturalWidth || 0) * 2 + (i.width || 0) + (i.src || "").length * 0.01,
      }))
      .sort((a, b) => b.score - a.score);
    return scored[0].i.currentSrc || scored[0].i.src || null;
  }

  // From the URL, if it happens to still be the old shape.
  // Kept as a thin alias so the existing call sites read clearly; all the real
  // work lives in fromDesignUrl.
  function fromUrl(href) {
    return fromDesignUrl(href);
  }

  // Artist, strategy: the image alt is built as "{title} {type} {tags} by {artist}",
  // so the tail after "by" is the name even when the card renders no text at all.
  function artistFromAlt(card) {
    const img = card.querySelector("img");
    if (!img) return null;
    for (const attr of ["alt", "aria-label", "title"]) {
      const v = clean(img.getAttribute(attr));
      if (!v) continue;
      const m = /\bby\s+([^\n]{2,40})\s*$/i.exec(v);
      if (m && plausibleName(m[1])) return tidyName(m[1]);
    }
    return null;
  }

  // The alt minus its "by <artist>" tail, with the trailing product-type run
  // shaved back off. Only used if the URL gave us nothing.
  function titleFromAlt(card, artist) {
    const img = card.querySelector("img");
    const v = clean(img && img.getAttribute("alt"));
    if (!v) return null;
    let t = v.replace(/\s+by\s+[^\n]{2,40}\s*$/i, "").trim();
    if (artist && tidyName(artist).length > 2) {
      t = t.replace(new RegExp("\\s*" + artist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$", "i"), "").trim();
    }
    return plausibleName(t) && t.length > 1 ? t : null;
  }

  function pickTitle(card, img, slug, linkText, artist) {
    // The shop name is often rendered in a heading on these cards, so any
    // candidate that IS the artist has to be skipped rather than taken.
    const isArtist = (v) => {
      const t = clean(v);
      return !!t && !!artist && t.toLowerCase() === clean(artist).toLowerCase();
    };

    for (const sel of [
      "[data-test*='title' i]",
      "[data-test*='name' i]",
      "[class*='title' i]",
    ]) {
      for (const n of Array.from(card.querySelectorAll(sel))) {
        const v = clean(n.textContent);
        if (v.length > 1 && !isArtist(v)) return v;
      }
    }
    for (const tag of ["h1", "h2", "h3", "h4"]) {
      for (const h of Array.from(card.querySelectorAll(tag))) {
        const v = clean(h.textContent);
        if (v.length > 1 && !isArtist(v)) return v;
      }
    }
    if (img) {
      for (const attr of ["alt", "data-alt", "title"]) {
        const v = clean(img.getAttribute(attr));
        if (v.length > 1 && !isArtist(v)) return v;
      }
    }
    const lt = clean(linkText);
    if (lt.length > 1 && !isArtist(lt)) return lt;
    if (slug) return clean(slug.replace(/-\d{5,}$/, "").replace(/-/g, " "));
    return "";
  }

  // A heading that isn't the artist is, with high probability, the shop name —
  // one more thing to try when the "by" pattern doesn't parse cleanly.
  function fromHeading(card) {
    for (const tag of ["h1", "h2", "h3", "h4"]) {
      for (const h of Array.from(card.querySelectorAll(tag))) {
        const t = clean(h.textContent);
        if (t && t.length > 1 && t.length < 60 && !/\$\d/.test(t)) return t;
      }
    }
    return null;
  }

  function pickPrice(text) {
    let m = /from\s*\$\s*([0-9]{1,4}(?:[.,][0-9]{2}))/i.exec(text);
    if (!m) m = /\$\s*([0-9]{1,4}(?:[.,][0-9]{2}))/.exec(text);
    if (!m) return null;
    const n = parseFloat(m[1].replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }

  // Observed card text shape: "<tags...> <ProductType> By <artist> From $X.XX"
  function splitCardText(text) {
    let typeIndex = -1;
    let productType = null;
    const lower = text.toLowerCase();
    for (const t of PRODUCT_TYPES) {
      const i = lower.indexOf(t);
      if (i !== -1 && (typeIndex === -1 || i < typeIndex)) {
        typeIndex = i;
        productType = t;
      }
    }
    const tagBlob = typeIndex > 0 ? text.slice(0, typeIndex) : "";
    const tail = typeIndex > 0 ? text.slice(typeIndex) : text;
    return { tagBlob: clean(tagBlob), productType, tail };
  }

  function tidyName(s) {
    return clean(s || "")
      .replace(/[.,;]\s*$/, "")
      .replace(/^(a|an|the)\s+/i, "")
      .trim();
  }

  // A shop handle: one unbroken token, no spaces. Redbubble's own handles
  // always look like this.
  function looksLikeHandle(s) {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$/.test(clean(s || ""));
  }

  // Would this text actually be a person's name rather than the rest of the
  // card? A greedy regex will happily run to the end of the string and hand
  // back "moon, celestial $19.00" — which is worse than admitting we don't
  // know, because it poisons every strategy below it.
  function plausibleName(s) {
    const t = tidyName(s);
    if (!t) return false;
    if (/^by$/i.test(t)) return false; // the label itself, not a name
    if (/\$/.test(t)) return false; // price bled in
    if (/\d+\.\d/.test(t)) return false;
    if (t.length > 40) return false;
    if (looksLikeHandle(t)) return true;
    // A display name with spaces is fine, as long as it's short and tidy.
    return !/[,\[\](){}<>|]/.test(t) && t.split(/\s+/).length <= 4;
  }

  // Artist, strategy A: the plain "by <name>" run in the card's text.
  function artistFromText(tail) {
    let m = /\bby\s+([^\n]{1,60}?)\s+from\s+\$/i.exec(tail);
    if (m && plausibleName(m[1])) return tidyName(m[1]);
    m = /\bby\s+([^\n]{1,40})/i.exec(tail);
    if (m && plausibleName(m[1])) return tidyName(m[1]);
    return null;
  }

  // Artist, strategy B: go read the DOM. Redbubble renders the shop name in a
  // heading *before* the word "by", and that heading is often the only place it
  // appears — innerText flattens it in a way the regex above can't reliably
  // pick apart.
  function artistFromDom(card) {
    const byNodes = [];
    for (const el of card.querySelectorAll("*")) {
      const t = (el.textContent || "").trim();
      if (/^by\b/i.test(t) && t.length < 120) byNodes.push(el);
    }
    if (!byNodes.length) return null;

    // The deepest "by ..." node is the tightest match.
    let node = byNodes[0];
    for (const n of byNodes) {
      if (n.textContent.length < node.textContent.length) node = n;
    }

    // If it's a shop link, its href is the most reliable answer of all.
    const link = node.closest("a[href]") || node.querySelector("a[href*='/shops/']");
    if (link) {
      const href = link.getAttribute("href") || "";
      const m = /\/shops\/([^/?#]+)/i.exec(href);
      if (m) {
        try {
          return tidyName(decodeURIComponent(m[1]));
        } catch (_) {
          return tidyName(m[1]);
        }
      }
    }

    // Text after "by" on the same node, if there is any. The node's own text is
    // usually padded with whitespace, so trim before matching or /^by/ never
    // fires and we hand back the word "by" as if it were a name.
    const after = tidyName(
      (node.textContent || "").trim().replace(/^by\b\s*/i, "")
    );
    if (after && plausibleName(after)) return after;

    // Otherwise the name sits in the element immediately before this one.
    let prev = node.previousElementSibling;
    for (let i = 0; i < 4 && prev; i++) {
      const pt = tidyName(prev.textContent);
      if (pt && pt.length < 60) return pt;
      prev = prev.previousElementSibling;
    }

    // Last resort: the card's parent may wrap "name by name" together.
    const cardText = tidyName(card.textContent);
    const m = /^(.{2,50}?)\s+by\s+/i.exec(cardText);
    if (m) return tidyName(m[1]);

    return null;
  }

  function pickTags(card, tagBlob, text, artist, title) {
    const out = [];
    const banned = new Set(
      [artist, title]
        .filter(Boolean)
        .map((x) => clean(x).toLowerCase())
        .filter(Boolean)
    );
    const keep = (t) => {
      t = clean(t);
      if (!t || t.length >= 40) return;
      if (banned.has(t.toLowerCase())) return;
      if (/^(by|from|sticker|shirt|card|print)$/i.test(t)) return;
      out.push(t);
    };

    // 1. Real tag elements, if the grid renders them.
    for (const n of card.querySelectorAll("[class*='tag' i]")) keep(n.textContent);

    // 2. The text sitting before the product type — that's the tag run.
    if (out.length < 2 && tagBlob) {
      for (const part of tagBlob.split(",")) {
        keep(part.replace(/^[\s,·•\-–—|]+|[\s,·•\-–—|]+$/g, ""));
      }
    }

    // 3. An explicit "Tags: a, b, c" run.
    if (out.length < 2) {
      const m = /tags?\s*:?\s*([^\n]{3,400})/i.exec(text);
      if (m) for (const part of m[1].split(",")) keep(part);
    }

    // 4. Longest comma run anywhere in the card.
    if (out.length < 2) {
      const m = /([a-z0-9' -]{3,30}(?:,\s*[a-z0-9' -]{3,30}){3,})/i.exec(text);
      if (m) for (const part of m[1].split(",")) keep(part);
    }

    return Array.from(new Set(out.map((t) => t.toLowerCase()))).slice(0, 30);
  }

  // A shop handle: one unbroken token, no spaces. Redbubble's own handles
  // always look like this.
  function looksLikeHandle(s) {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$/.test(clean(s || ""));
  }

  // Artist, strategy C — the strongest signal available: a link inside the card
  // that points at a shop. The product card itself usually links the design,
  // not the artist, so any /shops/ link found inside it is the artist.
  function shopFromCardLinks(card, excludeEl) {
    for (const link of card.querySelectorAll("a[href*='/shops/']")) {
      if (excludeEl && link === excludeEl) continue;
      const m = /\/shops\/([^/?#]+)/i.exec(link.getAttribute("href") || "");
      if (m) {
        try {
          return tidyName(decodeURIComponent(m[1]));
        } catch (_) {
          return tidyName(m[1]);
        }
      }
    }
    return null;
  }

  // Artist, strategy D — a link inside the card whose text is a bare handle.
  function handleFromCardLinks(card, excludeEl) {
    for (const link of card.querySelectorAll("a[href]")) {
      if (excludeEl && link === excludeEl) continue;
      const t = clean(link.textContent);
      if (t && looksLikeHandle(t)) return tidyName(t);
    }
    return null;
  }

  // Artist, strategy E — anything handle-shaped in the card's aria/alt text.
  function handleFromAttributes(card) {
    const nodes = card.querySelectorAll("[aria-label], [alt], [title]");
    for (const n of nodes) {
      for (const attr of ["aria-label", "alt", "title"]) {
        const v = clean(n.getAttribute(attr));
        if (v && looksLikeHandle(v)) return tidyName(v);
      }
    }
    return null;
  }

  // Run every strategy in order of how much we trust it.
  function resolveArtist(card, tail, href, anchor) {
    return (
      artistFromText(tail) ||
      shopFromCardLinks(card, anchor) ||
      artistFromDom(card) ||
      (SHOP_PATH.exec(href || "") ? fromUrl(href).shop : null) ||
      handleFromCardLinks(card, anchor) ||
      fromHeading(card) ||
      handleFromAttributes(card) ||
      null
    );
  }

  function buildDesign(a) {
    const href = a.href || a.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return null;

    const card = findCard(a);
    const text = clean(card.innerText || card.textContent || "");
    const img = card.querySelector("img");
    const u = fromDesignUrl(href);
    const { tagBlob, productType, tail } = splitCardText(text);

    // Artist first: the shop name is often the design's heading on these
    // cards, so picking the title first would call the artist the title.
    const artist = resolveArtist(card, tail, href, a) || u.shop || "";

    const title = u.title || pickTitle(card, img, u.slug, a.textContent, artist) || titleFromAlt(card, artist) || "";
    const tags = pickTags(card, tagBlob, text, artist, title);
    const image = pickImage(card);
    const type = u.productType || productType;

    // If we truly can't tell who made it, dump the card once so the console
    // says exactly what the markup looks like and it can be taught properly.
    if (!artist) {
      console.warn(
        "[RB Stumbler] couldn't resolve an artist for:",
        href,
        "\n--- card html ---\n",
        card.outerHTML.slice(0, 1200)
      );
    }

    // Nothing identifying at all → almost certainly a wrapper or a stray link.
    if (!title && !artist && !image && !tags.length) return null;

    const design = {
      key: href.split("#")[0],
      url: href.split("#")[0],
      artist: artist || u.shop || "",
      title,
      image,
      price: pickPrice(text),
      productType: type,
      tags,
      text,
    };

    // Never present the ugly fallback as a tag.
    if (!design.artist) design.artist = u.shop || "(unknown artist)";
    return design;
  }

  // ---------------------------------------------------------------- scrape

  function collectFrom(anchors, accept) {
    const out = new Map();
    for (const a of anchors) {
      if (isChrome(a)) continue;
      const href = a.href || a.getAttribute("href");
      if (!accept(a, href)) continue;
      const d = buildDesign(a);
      if (d && !out.has(d.key)) out.set(d.key, d);
    }
    return out;
  }

  function scrape() {
    const anchors = Array.from(document.querySelectorAll("a[href]"));

    // Pass 1: only links that genuinely point at a product page. This is the
    // sharp filter and it keeps footer badges, promo tiles and shop links out.
    const strict = collectFrom(anchors, (a, href) => looksLikeProductUrl(href));

    // Pass 2: only if that came back empty, so if Redbubble ever changes the
    // URL shape we degrade to "a link with a real image on the shop's own
    // domain" rather than returning nothing at all.
    if (strict.size) return Array.from(strict.values());

    const loose = collectFrom(
      anchors,
      (a, href) =>
        PRODUCT_HOSTS.has(hostOf(href)) &&
        !/^https?:\/\/(help|support)\./i.test(href) &&
        isProductLink(a)
    );
    return Array.from(loose.values());
  }

  // Redbubble lazy-loads the grid, so nudge it down as we poll.
  function nudgeScroll() {
    try {
      const atBottom =
        window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
      if (!atBottom) window.scrollBy(0, Math.round(window.innerHeight * 0.85));
    } catch (_) {}
  }

  function collect(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 9000);
    return new Promise((resolve) => {
      const tick = () => {
        const gate = pageGate();
        if (gate.blocked) {
          return resolve({ ok: false, reason: gate.reason, designs: [], count: 0, gate });
        }

        nudgeScroll();
        let designs = [];
        try {
          designs = scrape();
        } catch (_) {
          designs = [];
        }

        if (designs.length) return resolve({ ok: true, designs, count: designs.length, gate });
        if (Date.now() >= deadline) {
          return resolve({ ok: false, reason: "no-results", designs: [], count: 0, gate });
        }
        setTimeout(tick, 350);
      };
      tick();
    });
  }

  function pageGate() {
    const t = (document.title || "").toLowerCase();
    if (
      t.includes("just a moment") ||
      t.includes("attention required") ||
      document.querySelector("#challenge-form, #cf-challenge-running, #challenge-running")
    ) {
      return { blocked: true, reason: "cloudflare", title: document.title };
    }
    const body = clean(document.body ? document.body.innerText : "").slice(0, 400).toLowerCase();
    if (body.includes("we couldn't find any results") || body.includes("no results for")) {
      return { blocked: false, reason: "empty-results", title: document.title };
    }
    return { blocked: false, reason: "ok", title: document.title };
  }

    // ------------------------------------------------- similar designs (rabbit hole)
  // On a product page, essentially every /i/... link is a design. Grab them all
  // and drop the one we're already looking at — no new selectors needed, since
  // this reuses the product-URL test the scraper already trusts.
  function scrapeSimilar(excludeUrl) {
    const out = new Map();
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href || "";
      if (!looksLikeProductUrl(href)) continue;
      if (excludeUrl && href.split("#")[0] === excludeUrl.split("#")[0]) continue;
      if (isChrome(a)) continue;
      const d = buildDesign(a);
      if (d && !out.has(d.key)) out.set(d.key, d);
    }
    return Array.from(out.values());
  }

  // ---------------------------------------------------------------- heart

  // Click the favourite control on a design page. Redbubble shows the heart at
  // the top-right of the product image; these are the labels and test ids it
  // has used, tried in order of how specific they are.
  // Locate the favourite control without touching it, so the caller can wait
  // for it to exist rather than firing blind clicks at a half-loaded page.
  function findHeart() {
    const signedIn = !/sign in|log in/i.test(
      clean(document.body ? document.body.innerText.slice(0, 400) : "")
    );

    const labelled = Array.from(
      document.querySelectorAll("button, [role='button'], a")
    ).find((n) =>
      /^(add to (my |your )?list|remove from (my |your )?list|favou?rite)\b/i.test(
        clean(n.getAttribute("aria-label"))
      )
    );
    if (labelled) return { node: labelled, how: "aria-label" };

    const testId = document.querySelector(
      "[data-testid*='favourite-icon' i], [data-testid*='favorite-icon' i], [data-testid*='favourite' i], [data-testid*='favorite' i]"
    );
    if (testId) {
      return { node: testId.closest("button, [role='button'], a") || testId, how: "data-testid" };
    }

    const icon = document.querySelector(
      "[class*='FavoriteIcon_icon' i], [class*='FavouriteIcon' i], [data-testid='favourite-icon']"
    );
    if (icon) {
      return { node: icon.closest("button, [role='button'], a") || icon, how: "icon-class" };
    }

    return { node: null, how: "none", signedIn };
  }

  function alreadyFavourited(node) {
    return (
      node.getAttribute("aria-pressed") === "true" ||
      /^remove from/i.test(clean(node.getAttribute("aria-label"))) ||
      /\b(is-?active|is-?favorited|is-?favourited)\b/i.test(node.className || "")
    );
  }

  // React listens for a full pointer sequence on some of these controls, so
  // replay one rather than relying on .click() alone.
  function clickIt(node) {
    try {
      node.scrollIntoView({ block: "center" });
      const opts = { bubbles: true, cancelable: true, view: window };
      for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
        node.dispatchEvent(new MouseEvent(type, opts));
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e) };
    }
  }

  // ---------------------------------------------------------------- messages

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "rbstumbler:scrape") {
      collect(msg.timeoutMs).then(sendResponse);
      return true; // async
    }
    if (msg && msg.type === "rbstumbler:similar") {
      try {
        const designs = scrapeSimilar(msg.excludeUrl || "");
        sendResponse({ ok: true, designs, count: designs.length });
      } catch (e) {
        sendResponse({ ok: false, reason: String(e && e.message ? e.message : e), designs: [] });
      }
      return true;
    }

    if (msg && msg.type === "rbstumbler:find-heart") {
      // Report only — don't click. Lets the worker wait for the page to be ready.
      try {
        const h = findHeart();
        sendResponse({
          ok: true,
          found: !!h.node,
          how: h.how,
          signedIn: h.signedIn,
          already: h.node ? alreadyFavourited(h.node) : false,
        });
      } catch (e) {
        sendResponse({ ok: false, reason: String(e && e.message ? e.message : e) });
      }
      return true;
    }

    if (msg && msg.type === "rbstumbler:favorite") {
      try {
        const h = findHeart();
        if (!h.node) {
          sendResponse({ ok: false, reason: "no-heart-on-page", signedIn: h.signedIn });
          return true;
        }
        if (alreadyFavourited(h.node)) {
          sendResponse({ ok: true, already: true });
          return true;
        }
        const r = clickIt(h.node);
        // Let the site's own handler settle before we report back.
        setTimeout(() => sendResponse(r), 500);
      } catch (e) {
        sendResponse({ ok: false, reason: String(e && e.message ? e.message : e) });
      }
      return true;
    }

    if (msg && msg.type === "rbstumbler:ping") {
      sendResponse({ ok: true, url: location.href, title: document.title });
      return true;
    }
  });
})();