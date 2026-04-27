# Site Parser → TXT

Visual, client-side site parser. Open it in a browser, type a URL, click the blocks you want, and the app crawls the site and saves the extracted text as a single `.txt` file.

Live demo (GitHub Pages): https://blessblissmari.github.io/site-parser/

## How it works

1. **Open URL.** The HTML is fetched through a public CORS proxy (corsproxy.io / allorigins.win / codetabs.com — switchable in the UI) and rendered inside a sandboxed `<iframe>`. Scripts and inline event handlers from the original page are stripped before rendering, and a small overlay script is injected.
2. **Pick blocks.** Hover highlights elements; click selects one. The app builds a generalized CSS selector (e.g. `article.post > h2.post-title`) so the same selector matches similar blocks on other pages of the same template. Use ↑ to broaden a selector by dropping its last segment, or × to remove it.
3. **Crawl.** BFS over same-origin links from the start URL, with configurable depth, page limit, and delay. Each page is fetched via the CORS proxy, parsed with `DOMParser`, and the chosen selectors are applied. The result is a single TXT file.

## Limitations

- **Pure static app**: hosted on GitHub Pages, no backend. All fetching happens in the browser.
- **CORS proxies are public** and may be rate-limited or block specific sites. Switch the proxy in the UI if one fails.
- **JS-rendered content (SPA)** won't be parsed — only the HTML the server returns is visible. Without a headless browser there is no way around this in static hosting.
- **Robots.txt** is not honored automatically. Use sensibly: respect the target site's terms, set a reasonable delay, keep page count low.
- The iframe is sandboxed (`allow-scripts` only, opaque origin) so the parsed page cannot touch this app's storage or navigate the top window.

## Local development

This is plain static HTML/CSS/JS. Just open `index.html` in a browser, or:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000/
```

## Deployment

GitHub Pages is configured via `.github/workflows/pages.yml` to publish the repository root on every push to `main`.
