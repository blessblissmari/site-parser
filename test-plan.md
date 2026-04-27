# Test plan — site-parser

**Live URL:** https://blessblissmari.github.io/site-parser/
**PR:** https://github.com/blessblissmari/site-parser/pull/1 (merged)
**Target for parsing:** https://quotes.toscrape.com/ — a server-rendered scraping practice site with stable class names (`div.quote`, `span.text`, `small.author`) and pagination (`?page=N` and `/page/N/` linked from each page).

## What changed (user-visible)

A new static web app at the live URL where the user:
1. enters a website URL,
2. it loads in a sandboxed preview iframe through a public CORS proxy,
3. the user clicks blocks they want to extract,
4. the app crawls same-origin links (BFS, depth/page/delay-limited) and downloads a single TXT file with the text from those blocks across all visited pages.

## Primary end-to-end flow (one test)

### Setup actions
1. Open https://blessblissmari.github.io/site-parser/.
2. Type `https://quotes.toscrape.com/` into the URL input.
3. Leave the CORS proxy at the default `corsproxy.io`.
4. Click **"Открыть"**.

### Test: It should crawl quotes.toscrape.com and produce a TXT containing quotes and authors from multiple pages

**Preconditions to assert before continuing:**
- Within ~5 seconds the right pane shows the rendered quotes.toscrape.com homepage with at least one visible quote (e.g. *"The world as we have created it..."* by Albert Einstein).
- The "Лог" panel contains a line ending in `байт` (bytes loaded). Failure mode if the proxy is broken: error line in red.

**Click selection:**
5. In the preview, hover over the first quote's text (the italicised text starting with *"The world as we have created it..."*) — element should get a blue outline. Click it.
6. In the left "Выбранные блоки" list, expect a new entry whose CSS code segment ends with `span.text` and whose match count `× N` is **≥ 5** (the homepage has 10 quotes; selector should match multiple).
7. Hover and click on the author name *"Albert Einstein"* under that quote.
8. Expect a second entry whose code ends with `small.author` and match count **≥ 5**.

**Adversarial check on the selector list:** if either selector shows count `× 1` only, the generalisation is broken (it would have included an `nth-child` or similar) — record as a failure even if the crawl still produces some output.

**Crawl:**
9. Set "Глубина" = `1`, "Макс. страниц" = `5`, "Задержка, мс" = `400`. Leave "только этот домен" + "писать URL в TXT" checked.
10. Click **"Спарсить и скачать TXT"**.

**During crawl assertions:**
- The log shows progressive `✓ <url> — блоков: N` lines, `N ≥ 6` for each successful homepage / page/N/ URL (each such page has 10 quotes + 10 authors visible).
- Final log line is `Готово: K страниц.` with `K` equal to the actual number of fetched pages, **not greater than 5** (page cap honoured).
- A file named `parsed-quotes.toscrape.com-<timestamp>.txt` is downloaded.

**Post-crawl file assertions** (run via shell on the downloaded file):
- File exists in `/home/ubuntu/Downloads/`.
- Contains the literal substring `URL: https://quotes.toscrape.com/` (start page recorded).
- Contains text from at least 2 distinct quote pages — verify by counting `URL:` lines, expect `>= 2`.
- Contains the substring `Albert Einstein` (proves the author selector worked).
- Contains a recognisable quote substring such as `The world as we have created it` (proves the quote selector worked).
- Does NOT contain raw HTML tags like `<div` or `<span` (proves we extracted text, not markup).

### Failure modes that would make this test pass-by-accident if not checked
- If the proxy were broken, step 4 would produce an empty preview — caught by the precondition.
- If selectors were too specific (e.g. included a unique attribute), match counts would be 1 — caught in step 6/8.
- If extractor accidentally returned `outerHTML`, file would contain `<span` — caught by the "no raw tags" assertion.
- If crawler ignored the page cap, K could be far above 5 — caught by the cap assertion.

## Out of scope for this run
- SPA / JS-rendered sites (documented limitation).
- Non-default CORS proxies (will only swap if `corsproxy.io` fails).
- robots.txt / rate-limit politeness verification.
