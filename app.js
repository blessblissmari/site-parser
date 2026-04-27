// Site Parser — client-side static app.
// Step 1: fetch a page via CORS proxy, render it sandboxed in an iframe with an overlay
// that lets the user click blocks. Step 2: collect generalized CSS selectors. Step 3:
// BFS crawl same-origin pages, apply selectors, output a single TXT file.

(() => {
  "use strict";

  // ----- Elements -----
  const $ = (id) => document.getElementById(id);
  const urlInput = $("url");
  const proxySel = $("proxy");
  const loadBtn = $("loadBtn");
  const frame = $("frame");
  const previewTitle = $("previewTitle");
  const statusEl = $("status");
  const selectorsList = $("selectors");
  const clearSelBtn = $("clearSelBtn");
  const depthInput = $("depth");
  const maxPagesInput = $("maxPages");
  const delayInput = $("delay");
  const sameOriginInput = $("sameOrigin");
  const includeUrlsInput = $("includeUrls");
  const crawlBtn = $("crawlBtn");
  const stopBtn = $("stopBtn");
  const logEl = $("log");

  // ----- State -----
  let currentUrl = null;       // last successfully loaded URL
  let currentHtml = null;      // raw HTML of that page (without our injected overlay)
  let selectors = [];          // [{ selector, count }]
  let crawlAbort = false;

  // ----- Logging -----
  function log(msg, kind) {
    const span = document.createElement("span");
    if (kind) span.className = kind;
    span.textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
    logEl.appendChild(span);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function setStatus(text, kind) {
    statusEl.textContent = text || "";
    statusEl.className = "status" + (kind ? " " + kind : "");
  }

  // ----- CORS proxy -----
  function proxyUrl(rawUrl) {
    const enc = encodeURIComponent(rawUrl);
    switch (proxySel.value) {
      case "allorigins":
        return `https://api.allorigins.win/raw?url=${enc}`;
      case "codetabs":
        return `https://api.codetabs.com/v1/proxy/?quest=${enc}`;
      case "corsproxy":
      default:
        return `https://corsproxy.io/?url=${enc}`;
    }
  }

  async function fetchHtml(rawUrl) {
    const url = proxyUrl(rawUrl);
    const resp = await fetch(url, { redirect: "follow" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    if (!text || text.length < 5) throw new Error("Пустой ответ");
    return text;
  }

  // ----- HTML preparation -----
  // Strip scripts and inline event handlers to keep the iframe under our control,
  // then inject <base href> for relative URLs and our overlay script.
  function prepareHtml(rawHtml, baseUrl) {
    const doc = new DOMParser().parseFromString(rawHtml, "text/html");

    // Remove scripts and noscript blocks
    doc.querySelectorAll("script, noscript").forEach((n) => n.remove());

    // Remove inline event handlers (onclick=, etc) and javascript: hrefs
    doc.querySelectorAll("*").forEach((el) => {
      [...el.attributes].forEach((a) => {
        if (/^on/i.test(a.name)) el.removeAttribute(a.name);
        if (a.name === "href" && /^\s*javascript:/i.test(a.value)) el.setAttribute("href", "#");
      });
    });

    // Ensure <head> exists
    if (!doc.head) {
      const head = doc.createElement("head");
      doc.documentElement.insertBefore(head, doc.documentElement.firstChild);
    }

    // Insert <base href> first so relative links/images resolve against the original origin
    const existingBase = doc.querySelector("base");
    if (existingBase) existingBase.remove();
    const base = doc.createElement("base");
    base.setAttribute("href", baseUrl);
    doc.head.insertBefore(base, doc.head.firstChild);

    // Force every link to open in a new tab so the iframe doesn't navigate
    doc.querySelectorAll("a[href]").forEach((a) => a.setAttribute("target", "_blank"));

    // Inject overlay style + script
    const style = doc.createElement("style");
    style.textContent = `
      .__sp-hover { outline: 2px solid #4f8cff !important; outline-offset: 0 !important; cursor: crosshair !important; }
      .__sp-picked { outline: 2px solid #4ade80 !important; outline-offset: 0 !important; }
      html, body { cursor: crosshair !important; }
    `;
    doc.head.appendChild(style);

    const script = doc.createElement("script");
    script.textContent = OVERLAY_SCRIPT;
    doc.body.appendChild(script);

    return "<!doctype html>\n" + doc.documentElement.outerHTML;
  }

  // This script runs INSIDE the sandboxed iframe (allow-scripts only, opaque origin).
  // It sends messages to the parent via window.parent.postMessage.
  const OVERLAY_SCRIPT = `
    (function () {
      var lastHover = null;
      function isOurOverlay(el) { return false; }
      function getCssPath(el) {
        if (!el || el.nodeType !== 1) return "";
        var path = [];
        while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement && path.length < 6) {
          var seg = el.tagName.toLowerCase();
          if (el.id && /^[a-zA-Z][\\w-]*$/.test(el.id)) {
            seg = "#" + el.id;
            path.unshift(seg);
            break;
          }
          var classes = (el.className && typeof el.className === "string" ? el.className : "")
            .split(/\\s+/)
            .filter(Boolean)
            .filter(function (c) {
              return /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(c)
                && !/^(active|open|hover|focus|selected|disabled|hidden|visible|show|in|fade|sp-|__sp-)/i.test(c)
                && !/^(css-[a-f0-9]+|sc-[a-z0-9]+|jss\\d+|MuiBox-root|chakra-)/i.test(c)
                && !/^[a-z]+_[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+$/.test(c) // CSS modules hash
                && !/\\d{3,}/.test(c);
            })
            .slice(0, 2);
          if (classes.length) seg += "." + classes.join(".");
          path.unshift(seg);
          el = el.parentElement;
        }
        return path.join(" > ");
      }
      document.addEventListener("mouseover", function (e) {
        if (lastHover) lastHover.classList.remove("__sp-hover");
        lastHover = e.target;
        if (lastHover && lastHover.classList) lastHover.classList.add("__sp-hover");
      }, true);
      document.addEventListener("mouseout", function () {
        if (lastHover) lastHover.classList.remove("__sp-hover");
        lastHover = null;
      }, true);
      document.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var sel = getCssPath(e.target);
        try {
          var matches = sel ? document.querySelectorAll(sel).length : 0;
          document.querySelectorAll(sel).forEach(function (n) { n.classList.add("__sp-picked"); });
          window.parent.postMessage({ __sp: true, type: "pick", selector: sel, count: matches }, "*");
        } catch (err) {
          window.parent.postMessage({ __sp: true, type: "error", message: String(err) }, "*");
        }
      }, true);
      // Notify parent that overlay is ready
      window.parent.postMessage({ __sp: true, type: "ready", title: document.title || "" }, "*");
    })();
  `;

  // ----- Iframe load -----
  async function loadPage() {
    const raw = (urlInput.value || "").trim();
    if (!raw) return;
    let url;
    try { url = new URL(raw); } catch { setStatus("Невалидный URL", "err"); return; }

    setStatus("Загружаю…");
    log(`Загружаю ${url.href} через ${proxySel.value}`);
    loadBtn.disabled = true;
    try {
      const html = await fetchHtml(url.href);
      currentUrl = url.href;
      currentHtml = html;
      const prepared = prepareHtml(html, url.href);
      frame.srcdoc = prepared;
      previewTitle.textContent = url.href;
      setStatus("OK", "ok");
      log(`Загружено: ${html.length} байт`, "ok");
    } catch (err) {
      setStatus("Ошибка", "err");
      log(`Ошибка загрузки: ${err.message || err}`, "err");
    } finally {
      loadBtn.disabled = false;
    }
  }

  // ----- Selector list -----
  function renderSelectors() {
    selectorsList.innerHTML = "";
    selectors.forEach((s, idx) => {
      const li = document.createElement("li");
      const code = document.createElement("code");
      code.textContent = s.selector;
      const cnt = document.createElement("span");
      cnt.className = "count";
      cnt.textContent = `× ${s.count}`;
      const up = document.createElement("button");
      up.textContent = "↑";
      up.title = "Расширить (взять родителя)";
      up.onclick = () => broaden(idx);
      const del = document.createElement("button");
      del.textContent = "×";
      del.title = "Удалить";
      del.onclick = () => { selectors.splice(idx, 1); renderSelectors(); };
      li.append(code, cnt, up, del);
      selectorsList.appendChild(li);
    });
  }

  function addSelector(sel, count) {
    if (!sel) return;
    if (selectors.some((s) => s.selector === sel)) return;
    selectors.push({ selector: sel, count: count || 0 });
    renderSelectors();
    log(`+ ${sel} (на странице: ${count})`, "info");
  }

  // Broaden: drop the last segment of the descendant chain.
  function broaden(idx) {
    const s = selectors[idx];
    if (!s) return;
    const parts = s.selector.split(" > ");
    if (parts.length <= 1) return;
    parts.pop();
    s.selector = parts.join(" > ");
    // Re-count via the iframe document if we can reach it; otherwise leave as-is.
    try {
      const doc = frame.contentDocument;
      if (doc) s.count = doc.querySelectorAll(s.selector).length;
    } catch { /* opaque origin: cannot read */ }
    renderSelectors();
  }

  clearSelBtn.onclick = () => { selectors = []; renderSelectors(); };

  window.addEventListener("message", (e) => {
    const data = e.data;
    if (!data || !data.__sp) return;
    if (data.type === "pick") addSelector(data.selector, data.count);
    else if (data.type === "ready") log(`Превью готово: ${data.title || ""}`);
    else if (data.type === "error") log(`Iframe error: ${data.message}`, "err");
  });

  loadBtn.onclick = loadPage;
  urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") loadPage(); });

  // ----- Crawler -----
  function extractTextBySelectors(html, sels) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    // Remove non-content tags so innerText-like extraction is cleaner
    doc.querySelectorAll("script, style, noscript, svg").forEach((n) => n.remove());
    const out = [];
    for (const sel of sels) {
      let nodes;
      try { nodes = doc.querySelectorAll(sel); } catch { continue; }
      nodes.forEach((n) => {
        const t = (n.textContent || "").replace(/\s+/g, " ").trim();
        if (t) out.push(t);
      });
    }
    return out;
  }

  function extractLinks(html, baseUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const base = new URL(baseUrl);
    const links = new Set();
    doc.querySelectorAll("a[href]").forEach((a) => {
      const raw = a.getAttribute("href");
      if (!raw || /^(#|javascript:|mailto:|tel:)/i.test(raw)) return;
      try {
        const u = new URL(raw, base);
        u.hash = "";
        links.add(u.href);
      } catch { /* bad href */ }
    });
    return [...links];
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function crawl() {
    if (!currentUrl) { log("Сначала загрузите страницу.", "err"); return; }
    if (!selectors.length) { log("Выберите хотя бы один блок.", "err"); return; }

    const start = currentUrl;
    const startOrigin = new URL(start).origin;
    const maxDepth = Math.max(0, parseInt(depthInput.value, 10) || 0);
    const maxPages = Math.max(1, parseInt(maxPagesInput.value, 10) || 1);
    const delay = Math.max(0, parseInt(delayInput.value, 10) || 0);
    const sameOrigin = sameOriginInput.checked;
    const includeUrls = includeUrlsInput.checked;
    const sels = selectors.map((s) => s.selector);

    crawlAbort = false;
    crawlBtn.disabled = true;
    stopBtn.disabled = false;

    const visited = new Set();
    const queue = [{ url: start, depth: 0 }];
    const results = []; // { url, lines: string[] }

    log(`Старт обхода: ${start} (глубина=${maxDepth}, страниц=${maxPages}, селекторов=${sels.length})`, "info");

    while (queue.length && results.length < maxPages && !crawlAbort) {
      const { url, depth } = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);

      let html;
      try {
        html = await fetchHtml(url);
      } catch (err) {
        log(`✗ ${url} — ${err.message || err}`, "err");
        if (delay) await sleep(delay);
        continue;
      }

      const lines = extractTextBySelectors(html, sels);
      results.push({ url, lines });
      log(`✓ ${url} — блоков: ${lines.length}`, "ok");

      if (depth < maxDepth) {
        const links = extractLinks(html, url);
        for (const link of links) {
          if (visited.has(link)) continue;
          if (sameOrigin && new URL(link).origin !== startOrigin) continue;
          queue.push({ url: link, depth: depth + 1 });
        }
      }
      if (delay) await sleep(delay);
    }

    log(`Готово: ${results.length} страниц.`, "ok");
    downloadTxt(results, includeUrls, start);

    crawlBtn.disabled = false;
    stopBtn.disabled = true;
  }

  function downloadTxt(results, includeUrls, startUrl) {
    const parts = [];
    parts.push(`# Site Parser`);
    parts.push(`# source: ${startUrl}`);
    parts.push(`# pages: ${results.length}`);
    parts.push(`# generated: ${new Date().toISOString()}`);
    parts.push("");
    for (const r of results) {
      if (includeUrls) {
        parts.push("=".repeat(80));
        parts.push(`URL: ${r.url}`);
        parts.push("=".repeat(80));
      }
      for (const line of r.lines) parts.push(line);
      parts.push("");
    }
    const blob = new Blob([parts.join("\n")], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    const fname = `parsed-${new URL(startUrl).hostname}-${Date.now()}.txt`;
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    log(`Скачан файл: ${fname}`, "ok");
  }

  crawlBtn.onclick = crawl;
  stopBtn.onclick = () => { crawlAbort = true; log("Останавливаю…"); };

  // Restore last URL
  try {
    const saved = localStorage.getItem("sp:lastUrl");
    if (saved) urlInput.value = saved;
  } catch { /* ignore */ }
  urlInput.addEventListener("change", () => {
    try { localStorage.setItem("sp:lastUrl", urlInput.value); } catch { /* ignore */ }
  });
})();
