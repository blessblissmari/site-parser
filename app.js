// Site Parser — client-side static app.
// Step 1: fetch a page via CORS proxy, render it sandboxed in an iframe with an overlay
// that lets the user click blocks. Step 2: collect generalized CSS selectors with a
// per-selector output format (auto-suggested from the clicked element). Step 3: BFS
// crawl same-origin pages, apply selectors, output a single TXT file.

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

  // ----- Format catalog -----
  // Each format defines how the extracted nodes for a selector are turned into text lines.
  // `extract(node)` returns an array of strings (one or more lines) for a single matched node.
  const FORMATS = {
    text: {
      label: "Текст",
      extract: (n) => {
        const t = (n.textContent || "").replace(/\s+/g, " ").trim();
        return t ? [t] : [];
      },
    },
    lines: {
      label: "Текст построчно",
      extract: (n) => {
        // preserve <br> and block boundaries as line breaks
        const html = n.innerHTML
          .replace(/<\s*br\s*\/?\s*>/gi, "\n")
          .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n</$1>");
        const tmp = n.ownerDocument.createElement("div");
        tmp.innerHTML = html;
        return (tmp.textContent || "")
          .split(/\n+/)
          .map((s) => s.replace(/\s+/g, " ").trim())
          .filter(Boolean);
      },
    },
    list: {
      label: "Список",
      extract: (n) => {
        const items = [...n.querySelectorAll(":scope > li, :scope li")];
        const seen = new Set();
        const out = [];
        items.forEach((li) => {
          // skip nested li already counted (querySelectorAll returns descendants in order;
          // dedupe by exact element identity – Set handles it)
          if (seen.has(li)) return;
          seen.add(li);
          const t = (li.textContent || "").replace(/\s+/g, " ").trim();
          if (t) out.push(`- ${t}`);
        });
        if (!out.length) {
          const t = (n.textContent || "").replace(/\s+/g, " ").trim();
          if (t) out.push(`- ${t}`);
        }
        return out;
      },
    },
    kv: {
      label: "Таблица: ключ → значение",
      extract: (n) => {
        const out = [];
        // <table>: try header row + rows, or 2-column rows
        n.querySelectorAll("tr").forEach((tr) => {
          const cells = [...tr.querySelectorAll("th, td")].map((c) =>
            (c.textContent || "").replace(/\s+/g, " ").trim()
          );
          if (cells.length === 2 && cells[0] && cells[1]) {
            out.push(`${cells[0]}: ${cells[1]}`);
          } else if (cells.length > 2) {
            out.push(cells.join(" | "));
          }
        });
        // <dl>: dt/dd pairs
        const dts = [...n.querySelectorAll("dt")];
        dts.forEach((dt) => {
          const dd = dt.nextElementSibling;
          if (dd && dd.tagName.toLowerCase() === "dd") {
            const k = (dt.textContent || "").replace(/\s+/g, " ").trim();
            const v = (dd.textContent || "").replace(/\s+/g, " ").trim();
            if (k && v) out.push(`${k}: ${v}`);
          }
        });
        // Pattern: heading/strong followed by sibling text (e.g. spec lists)
        if (!out.length) {
          [...n.children].forEach((child) => {
            const label = child.querySelector("strong, b, dt, h1, h2, h3, h4, h5, h6, .label, .spec-name, .name");
            if (!label) return;
            const k = (label.textContent || "").replace(/\s+/g, " ").trim();
            const clone = child.cloneNode(true);
            const labelInClone = clone.querySelector("strong, b, dt, h1, h2, h3, h4, h5, h6, .label, .spec-name, .name");
            if (labelInClone) labelInClone.remove();
            const v = (clone.textContent || "").replace(/\s+/g, " ").trim();
            if (k && v) out.push(`${k}: ${v}`);
          });
        }
        if (!out.length) {
          const t = (n.textContent || "").replace(/\s+/g, " ").trim();
          if (t) out.push(t);
        }
        return out;
      },
    },
    links: {
      label: "Ссылки (текст — URL)",
      extract: (n) => {
        const anchors = n.tagName.toLowerCase() === "a" ? [n] : [...n.querySelectorAll("a[href]")];
        return anchors
          .map((a) => {
            const text = (a.textContent || "").replace(/\s+/g, " ").trim();
            const href = a.getAttribute("href") || "";
            if (!href) return null;
            return text ? `${text} — ${href}` : href;
          })
          .filter(Boolean);
      },
    },
    image: {
      label: "Картинки (alt — URL)",
      extract: (n) => {
        const imgs = n.tagName.toLowerCase() === "img" ? [n] : [...n.querySelectorAll("img")];
        return imgs
          .map((img) => {
            const alt = (img.getAttribute("alt") || "").replace(/\s+/g, " ").trim();
            const src = img.getAttribute("src") || "";
            if (!src) return null;
            return alt ? `${alt} — ${src}` : src;
          })
          .filter(Boolean);
      },
    },
    json: {
      label: "JSON {tag, text, attrs}",
      extract: (n) => {
        const obj = {
          tag: n.tagName.toLowerCase(),
          text: (n.textContent || "").replace(/\s+/g, " ").trim(),
        };
        const attrs = {};
        for (const a of n.attributes) {
          if (a.name === "style" || a.name.startsWith("on") || a.name.startsWith("__sp")) continue;
          attrs[a.name] = a.value;
        }
        if (Object.keys(attrs).length) obj.attrs = attrs;
        return [JSON.stringify(obj)];
      },
    },
  };

  // ----- State -----
  let currentUrl = null;
  let currentHtml = null;
  let selectors = []; // [{ selector, count, format }]
  let crawlAbort = false;

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

  function prepareHtml(rawHtml, baseUrl) {
    const doc = new DOMParser().parseFromString(rawHtml, "text/html");
    doc.querySelectorAll("script, noscript").forEach((n) => n.remove());
    doc.querySelectorAll("*").forEach((el) => {
      [...el.attributes].forEach((a) => {
        if (/^on/i.test(a.name)) el.removeAttribute(a.name);
        if (a.name === "href" && /^\s*javascript:/i.test(a.value)) el.setAttribute("href", "#");
      });
    });
    if (!doc.head) {
      const head = doc.createElement("head");
      doc.documentElement.insertBefore(head, doc.documentElement.firstChild);
    }
    const existingBase = doc.querySelector("base");
    if (existingBase) existingBase.remove();
    const base = doc.createElement("base");
    base.setAttribute("href", baseUrl);
    doc.head.insertBefore(base, doc.head.firstChild);
    doc.querySelectorAll("a[href]").forEach((a) => a.setAttribute("target", "_blank"));

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

  // Runs INSIDE the sandboxed iframe (allow-scripts only, opaque origin).
  // Detects element type and posts a message with selector, count, suggested format,
  // and a small preview snippet so the parent can pre-fill the UI.
  const OVERLAY_SCRIPT = `
    (function () {
      var lastHover = null;

      function getCssPath(el) {
        if (!el || el.nodeType !== 1) return "";
        var path = [];
        while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement && path.length < 6) {
          var seg = el.tagName.toLowerCase();
          if (el.id && /^[a-zA-Z][\\w-]*$/.test(el.id)) {
            path.unshift("#" + el.id);
            break;
          }
          var classes = (el.className && typeof el.className === "string" ? el.className : "")
            .split(/\\s+/)
            .filter(Boolean)
            .filter(function (c) {
              return /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(c)
                && !/^(active|open|hover|focus|selected|disabled|hidden|visible|show|in|fade|sp-|__sp-)/i.test(c)
                && !/^(css-[a-f0-9]+|sc-[a-z0-9]+|jss\\d+|MuiBox-root|chakra-)/i.test(c)
                && !/^[a-z]+_[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+$/.test(c)
                && !/\\d{3,}/.test(c);
            })
            .slice(0, 2);
          if (classes.length) seg += "." + classes.join(".");
          path.unshift(seg);
          el = el.parentElement;
        }
        return path.join(" > ");
      }

      function suggestFormat(el) {
        if (!el) return "text";
        // Direct tag check on the clicked element first.
        var direct = formatForTag(el.tagName.toLowerCase());
        if (direct) return direct;
        // Then walk up to 4 ancestors to honour the *context* the user clicked
        // inside (e.g. clicking a <td> inside a Wikipedia infobox should still
        // suggest kv because the surrounding <table> is what matters).
        var node = el.parentElement;
        var hops = 0;
        while (node && hops < 4) {
          var f = formatForTag(node.tagName.toLowerCase());
          if (f) return f;
          var clsHint = classHint(node);
          if (clsHint) return clsHint;
          node = node.parentElement;
          hops++;
        }
        // Fall back to inspecting descendants/structure of the clicked element.
        if (el.querySelector && el.querySelector("table, dl")) return "kv";
        if (el.querySelectorAll && el.querySelectorAll("dt, th").length >= 2) return "kv";
        if (el.querySelector && (el.querySelector("ul") || el.querySelector("ol"))) return "list";
        if (el.querySelectorAll && el.querySelectorAll("a[href]").length >= 3) return "links";
        if (el.querySelectorAll && el.querySelectorAll("img").length >= 2) return "image";
        var ownHint = classHint(el);
        if (ownHint) return ownHint;
        // Repeated label/value siblings → looks like a spec block
        if (el.querySelectorAll && el.querySelectorAll(":scope > * > strong, :scope > * > b").length >= 2) return "kv";
        return "text";
      }
      function formatForTag(tag) {
        if (tag === "table" || tag === "tbody" || tag === "thead" || tag === "tfoot" || tag === "tr" || tag === "th" || tag === "td" || tag === "dl" || tag === "dt" || tag === "dd") return "kv";
        if (tag === "ul" || tag === "ol" || tag === "li") return "list";
        if (tag === "a") return "links";
        if (tag === "img" || tag === "figure") return "image";
        return null;
      }
      function classHint(node) {
        var cls = (node.className && typeof node.className === "string" ? node.className : "").toLowerCase();
        if (!cls) return null;
        if (/(infobox|spec|characteristic|features?|params?|attributes?|properties?|details?|prop)/.test(cls)) return "kv";
        if (/(\\blist\\b|\\bitems?\\b|\\bmenu\\b|\\bnav\\b)/.test(cls)) return "list";
        return null;
      }

      function preview(el) {
        var t = (el.textContent || "").replace(/\\s+/g, " ").trim();
        return t.length > 120 ? t.slice(0, 120) + "…" : t;
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
      // When the user clicks deep inside a structured container (a <td> inside
      // a <table>, an <li> inside a <ul>, etc.) we want to pick the container
      // itself so the extracted output is the whole structured block, not a
      // leaf cell.
      function findContainer(el) {
        var node = el;
        var hops = 0;
        while (node && hops < 4) {
          var tag = node.tagName.toLowerCase();
          if (tag === "table" || tag === "dl" || tag === "ul" || tag === "ol" || tag === "figure") return node;
          var cls = (node.className && typeof node.className === "string" ? node.className : "").toLowerCase();
          if (/(infobox|spec|characteristic|features?|params?|attributes?|properties?|details?)/.test(cls)) return node;
          node = node.parentElement;
          hops++;
        }
        return el;
      }

      document.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var target = findContainer(e.target);
        var sel = getCssPath(target);
        try {
          var matches = sel ? document.querySelectorAll(sel) : [];
          matches.forEach(function (n) { n.classList.add("__sp-picked"); });
          window.parent.postMessage({
            __sp: true,
            type: "pick",
            selector: sel,
            count: matches.length,
            tag: target.tagName.toLowerCase(),
            suggested: suggestFormat(target),
            preview: preview(target),
          }, "*");
        } catch (err) {
          window.parent.postMessage({ __sp: true, type: "error", message: String(err) }, "*");
        }
      }, true);

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

  // ----- Selector list rendering -----
  function renderSelectors() {
    selectorsList.innerHTML = "";
    selectors.forEach((s, idx) => {
      const li = document.createElement("li");

      const top = document.createElement("div");
      top.className = "sel-row";
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
      top.append(code, cnt, up, del);

      const fmt = document.createElement("div");
      fmt.className = "sel-row sel-fmt";
      const label = document.createElement("label");
      label.textContent = "формат:";
      label.className = "muted small";
      const sel = document.createElement("select");
      Object.entries(FORMATS).forEach(([key, def]) => {
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = def.label;
        if (key === s.format) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.onchange = () => { s.format = sel.value; renderSelectors(); };
      const auto = document.createElement("span");
      auto.className = "muted small";
      if (s.suggestedTag) auto.textContent = `авто: <${s.suggestedTag}>`;
      fmt.append(label, sel, auto);

      li.append(top, fmt);
      if (s.preview) {
        const pv = document.createElement("div");
        pv.className = "sel-preview muted small";
        pv.textContent = s.preview;
        li.appendChild(pv);
      }
      selectorsList.appendChild(li);
    });
  }

  function addSelector(payload) {
    const sel = payload.selector;
    if (!sel) return;
    if (selectors.some((s) => s.selector === sel)) return;
    selectors.push({
      selector: sel,
      count: payload.count || 0,
      format: payload.suggested || "text",
      suggestedTag: payload.tag || "",
      preview: payload.preview || "",
    });
    renderSelectors();
    log(`+ ${sel} (на странице: ${payload.count}, формат: ${FORMATS[payload.suggested]?.label || "Текст"})`, "info");
  }

  function broaden(idx) {
    const s = selectors[idx];
    if (!s) return;
    const parts = s.selector.split(" > ");
    if (parts.length <= 1) return;
    parts.pop();
    s.selector = parts.join(" > ");
    renderSelectors();
  }

  clearSelBtn.onclick = () => { selectors = []; renderSelectors(); };

  window.addEventListener("message", (e) => {
    const data = e.data;
    if (!data || !data.__sp) return;
    if (data.type === "pick") addSelector(data);
    else if (data.type === "ready") log(`Превью готово: ${data.title || ""}`);
    else if (data.type === "error") log(`Iframe error: ${data.message}`, "err");
  });

  loadBtn.onclick = loadPage;
  urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") loadPage(); });

  // ----- Crawler -----
  function extractFromHtml(html, sels) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, style, noscript, svg").forEach((n) => n.remove());
    const sections = []; // [{ selector, format, lines }]
    for (const s of sels) {
      const fmt = FORMATS[s.format] || FORMATS.text;
      let nodes;
      try { nodes = [...doc.querySelectorAll(s.selector)]; } catch { continue; }
      const lines = [];
      nodes.forEach((n) => {
        const out = fmt.extract(n);
        if (Array.isArray(out)) lines.push(...out);
        else if (out) lines.push(String(out));
      });
      sections.push({ selector: s.selector, format: s.format, label: fmt.label, lines });
    }
    return sections;
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
    const sels = selectors.map((s) => ({ selector: s.selector, format: s.format }));

    crawlAbort = false;
    crawlBtn.disabled = true;
    stopBtn.disabled = false;

    const visited = new Set();
    const queue = [{ url: start, depth: 0 }];
    const results = []; // { url, sections }

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

      const sections = extractFromHtml(html, sels);
      const total = sections.reduce((a, s) => a + s.lines.length, 0);
      results.push({ url, sections });
      log(`✓ ${url} — строк: ${total}`, "ok");

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
      for (const sec of r.sections) {
        if (sec.lines.length === 0) continue;
        parts.push(`-- ${sec.label} [${sec.selector}] --`);
        for (const line of sec.lines) parts.push(line);
        parts.push("");
      }
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

  try {
    const saved = localStorage.getItem("sp:lastUrl");
    if (saved) urlInput.value = saved;
  } catch { /* ignore */ }
  urlInput.addEventListener("change", () => {
    try { localStorage.setItem("sp:lastUrl", urlInput.value); } catch { /* ignore */ }
  });
})();
