import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { volumes } from "./contents.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const distRoot = path.join(__dirname, "dist");
const encoder = new TextEncoder();

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const stripTags = (value) => String(value ?? "")
  .replace(/<br\s*\/?>/gi, " ")
  .replace(/<[^>]+>/g, "")
  .replace(/\s+/g, " ")
  .trim();

const cleanSource = (source) => {
  let value = source.replace(/^\uFEFF/, "").trim();
  value = value.replace(/^```(?:html)?\s*/i, "");
  value = value.replace(/\s*```\s*$/i, "");
  return value.trim();
};

const parseDocument = (source, fallbackTitle) => {
  const cleaned = cleanSource(source);
  const title = cleaned.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const closedBody = cleaned.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1];
  const openBody = cleaned.match(/<body\b[^>]*>([\s\S]*)/i)?.[1];
  return {
    title: stripTags(title) || fallbackTitle,
    bodyHtml: (closedBody || openBody || cleaned).trim()
  };
};

const pad4 = (page) => String(page).padStart(4, "0");
const pageUrl = (volume, page) => `/books/${volume}/page/${page}.html`;
const scanUrl = (scanOutputDir, page) => `/${scanOutputDir}/page_${pad4(page)}.png`;

const normalizeToc = (toc) => toc.map(([html, page], index) => ({
  index,
  level: Number(html.match(/^<h([1-4])\b/i)?.[1] || 1),
  title: stripTags(html),
  page
}));

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function scanVolume(volume, config) {
  const inputDir = path.join(repoRoot, config.textDir);
  const scanDir = path.resolve(__dirname, config.scanDir);
  const scanOutputDir = config.scanOutputDir || path.basename(scanDir);
  const names = await fs.readdir(inputDir);
  const pattern = new RegExp(`^${config.textPrefix}-(\\d+)\\.html$`, "i");
  const pages = names
    .map((name) => {
      const match = name.match(pattern);
      if (!match) return null;
      return {
        volume: Number(volume),
        page: Number(match[1]),
        fileName: name,
        inputPath: path.join(inputDir, name)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.page - b.page);

  const pageSet = new Set(pages.map((item) => item.page));
  const normalizedToc = normalizeToc(config.toc).map((entry) => {
    if (pageSet.has(entry.page)) return { ...entry, linkedPage: entry.page };
    const nearest = pages.find((item) => item.page >= entry.page) || pages.at(-1);
    return { ...entry, linkedPage: nearest?.page ?? entry.page };
  });

  const missingScans = [];
  for (const item of pages) {
    item.scanPath = path.join(scanDir, `page_${pad4(item.page)}.png`);
    item.hasScan = await exists(item.scanPath);
    if (!item.hasScan) missingScans.push(item.page);
  }

  return {
    volume: Number(volume),
    config,
    scanSourceDir: scanDir,
    scanOutputDir,
    pages,
    toc: normalizedToc,
    missingScans
  };
}

function currentTocIndex(toc, page) {
  let active = 0;
  for (let i = 0; i < toc.length; i += 1) {
    if (toc[i].page <= page) active = i;
    else break;
  }
  return active;
}

function renderToc(volumeData, activeIndex = -1) {
  return volumeData.toc.map((entry, index) => `
    <li style="--level:${entry.level}">
      <a href="${pageUrl(volumeData.volume, entry.linkedPage)}"${index === activeIndex ? ' class="active" aria-current="location"' : ""}>
        <span class="toc-page">${entry.page}</span>${escapeHtml(entry.title)}
      </a>
    </li>`).join("");
}

function volumeOptions(activeVolume) {
  return Object.entries(volumes).map(([volume, config]) =>
    `<option value="${volume}"${Number(volume) === Number(activeVolume) ? " selected" : ""}>${escapeHtml(config.shortTitle)}</option>`
  ).join("");
}

function renderHeader({ volume, context, subcontext, citation = null }) {
  return `
  <header class="site-header">
    <a class="brand" href="/">
      <span class="brand-mark">M</span>
      <span class="brand-label">马恩文集 · 数字阅读</span>
    </a>
    <div class="page-context">
      <strong>${escapeHtml(context)}</strong>
      <span>${escapeHtml(subcontext)}</span>
    </div>
    <div class="header-actions">
      <select class="header-select" data-volume-select aria-label="切换卷册">${volumeOptions(volume)}</select>
      ${citation ? `<button class="icon-button" type="button" data-copy-page-citation data-citation="${escapeHtml(citation)}">引用</button>` : ""}
      <button class="icon-button" type="button" data-open-toc aria-expanded="false">目录</button>
    </div>
  </header>`;
}

function renderDrawer(volumeData, activeIndex) {
  return `
  <button class="toc-backdrop" type="button" aria-label="关闭目录"></button>
  <aside class="toc-drawer" aria-label="${escapeHtml(volumeData.config.title)}目录">
    <div class="toc-header">
      <strong>${escapeHtml(volumeData.config.shortTitle)}目录</strong>
      <button type="button" data-close-toc aria-label="关闭目录">×</button>
    </div>
    <ol class="toc-list">${renderToc(volumeData, activeIndex)}</ol>
  </aside>`;
}

function renderNavLink(item, relation) {
  const previous = relation === "prev";
  if (!item) {
    return `<a aria-disabled="true"><span>${previous ? "←" : "→"}</span><span class="nav-label">${previous ? "上一页" : "下一页"}</span></a>`;
  }
  return `<a href="${pageUrl(item.volume, item.page)}" rel="${relation}">
    ${previous ? "<span>←</span>" : ""}
    <span class="nav-label">${previous ? "上一页" : "下一页"}</span>
    ${previous ? "" : "<span>→</span>"}
  </a>`;
}

function renderPage(volumeData, item, document, index) {
  const activeIndex = currentTocIndex(volumeData.toc, item.page);
  const active = volumeData.toc[activeIndex];
  const previous = volumeData.pages[index - 1];
  const next = volumeData.pages[index + 1];
  const src = scanUrl(volumeData.scanOutputDir, item.page);
  const scanMarkup = item.hasScan
    ? `<img src="${src}" alt="${escapeHtml(volumeData.config.shortTitle)}第${item.page}页扫描原图" loading="eager" decoding="async">`
    : `<p>未找到本页扫描图：page_${pad4(item.page)}.png</p>`;
  const mobileScanMarkup = item.hasScan
    ? `<img data-src="${src}" alt="${escapeHtml(volumeData.config.shortTitle)}第${item.page}页扫描原图" decoding="async">
       <button type="button" data-open-scan>全屏查看原图</button>`
    : `<p>未找到本页扫描图。</p>`;
  const dialog = item.hasScan ? `
  <dialog class="scan-dialog" id="scan-dialog">
    <div class="dialog-tools">
      <button type="button" data-zoom-out aria-label="缩小">−</button>
      <button type="button" data-zoom-fit>适应屏幕</button>
      <button type="button" data-zoom-in aria-label="放大">＋</button>
      <button type="button" data-close-scan>关闭</button>
    </div>
    <div class="dialog-stage">
      <img data-src="${src}" alt="${escapeHtml(volumeData.config.shortTitle)}第${item.page}页扫描原图">
    </div>
  </dialog>` : "";
  const footnotePopover = `
  <div class="footnote-popover" id="footnote-popover" role="dialog" aria-label="脚注" aria-hidden="true">
    <div class="footnote-popover__body" data-footnote-body></div>
    <a class="footnote-popover__jump" href="#" data-footnote-jump>跳到对应脚注</a>
  </div>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="${escapeHtml(`${volumeData.config.title}第${item.page}页文本与扫描原图对照阅读`)}">
  <title>${escapeHtml(document.title)} · ${escapeHtml(volumeData.config.shortTitle)}第${item.page}页</title>
  <link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
  ${renderHeader({
    volume: item.volume,
    context: active?.title || document.title,
    subcontext: `${volumeData.config.shortTitle} · 第 ${item.page} 页`,
    citation: `${volumeData.config.citation.title}, 第${item.volume}卷, ${volumeData.config.citation.place}: ${volumeData.config.citation.publisher}, ${volumeData.config.citation.year}年, 第${item.page}页`
  })}
  ${renderDrawer(volumeData, activeIndex)}
  <main class="reader-grid">
    <article class="text-pane">
      <div class="prose">${document.bodyHtml}</div>
    </article>
    <aside class="scan-pane" aria-label="本页扫描原图">
      <div class="scan-tools"><button type="button" data-open-scan>全屏原图</button></div>
      ${scanMarkup}
    </aside>
    <section class="mobile-scan" aria-label="本页扫描原图">
      <details>
        <summary>查看本页扫描原图</summary>
        <div class="mobile-scan-inner">${mobileScanMarkup}</div>
      </details>
    </section>
  </main>
  <footer class="page-footer">
    ${renderNavLink(previous, "prev")}
    <div class="page-position">第 ${item.page} 页 · ${index + 1} / ${volumeData.pages.length}</div>
    ${renderNavLink(next, "next")}
  </footer>
  ${dialog}
  ${footnotePopover}
  <script src="/assets/app.js" defer></script>
</body>
</html>`;
}

function renderVolumeIndex(volumeData) {
  const first = volumeData.pages[0];
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(volumeData.config.title)} · 目录</title>
  <link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
  ${renderHeader({
    volume: volumeData.volume,
    context: volumeData.config.title,
    subcontext: `${volumeData.config.subtitle} · ${volumeData.pages.length} 个正文页面`
  })}
  ${renderDrawer(volumeData, -1)}
  <main class="volume-home">
    <div class="home-kicker">${escapeHtml(volumeData.config.shortTitle)}</div>
    <h1>${escapeHtml(volumeData.config.subtitle)}</h1>
    <p class="home-lead">按印刷页码将整理文本与扫描原图并置。桌面端为左右对照，移动端为文本在上、扫描图可折叠展开。</p>
    <p><a class="icon-button" style="display:inline-flex;align-items:center;background:var(--red);text-decoration:none" href="${pageUrl(volumeData.volume, first.page)}">从第 ${first.page} 页开始阅读 →</a></p>
    <ol class="toc-list" style="height:auto;margin-top:36px;padding:0">${renderToc(volumeData, -1)}</ol>
  </main>
  <script src="/assets/app.js" defer></script>
</body>
</html>`;
}

function renderHome(allVolumes) {
  const cards = allVolumes.map((volumeData) => {
    const first = volumeData.pages[0];
    return `<a class="volume-card" href="/books/${volumeData.volume}/">
      <span>${escapeHtml(volumeData.config.shortTitle)}</span>
      <h2>${escapeHtml(volumeData.config.subtitle)}</h2>
      <p>${volumeData.pages.length} 个正文页面，正文起于印刷第 ${first.page} 页。</p>
    </a>`;
  }).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>马恩文集 · 文本与扫描原图对照阅读</title>
  <link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
  <header class="site-header">
    <a class="brand" href="/"><span class="brand-mark">M</span><span class="brand-label">马恩文集 · 数字阅读</span></a>
    <div class="page-context"><strong>文本与扫描原图对照阅读</strong><span>静态站 Demo</span></div>
    <div></div>
  </header>
  <main class="volume-home">
    <div class="home-kicker">Parallel Reader Demo</div>
    <h1>让整理文本与原书页面彼此作证</h1>
    <p class="home-lead">这是以第六、七卷为样本的静态阅读站。进入任一卷册后，可按目录、页码或键盘左右方向键翻页。</p>
    <div class="volume-cards">${cards}</div>
  </main>
</body>
</html>`;
}

async function writeText(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, encoder.encode(content));
}

async function build() {
  await fs.rm(distRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(distRoot, "assets"), { recursive: true });
  await Promise.all([
    fs.copyFile(path.join(__dirname, "src", "styles.css"), path.join(distRoot, "assets", "styles.css")),
    fs.copyFile(path.join(__dirname, "src", "app.js"), path.join(distRoot, "assets", "app.js"))
  ]);

  const allVolumes = [];
  const copiedScanDirs = new Set();
  const report = {
    generatedAt: new Date().toISOString(),
    volumes: {}
  };

  for (const [volume, config] of Object.entries(volumes)) {
    const volumeData = await scanVolume(volume, config);
    allVolumes.push(volumeData);

    if (!copiedScanDirs.has(volumeData.scanOutputDir)) {
      await fs.cp(
        volumeData.scanSourceDir,
        path.join(distRoot, volumeData.scanOutputDir),
        { recursive: true }
      );
      copiedScanDirs.add(volumeData.scanOutputDir);
    }

    for (let index = 0; index < volumeData.pages.length; index += 1) {
      const item = volumeData.pages[index];
      const source = await fs.readFile(item.inputPath, "utf8");
      const document = parseDocument(source, `${config.shortTitle}第${item.page}页`);
      const outputPath = path.join(distRoot, "books", volume, "page", `${item.page}.html`);
      await writeText(outputPath, renderPage(volumeData, item, document, index));
    }

    await writeText(
      path.join(distRoot, "books", volume, "index.html"),
      renderVolumeIndex(volumeData)
    );

    report.volumes[volume] = {
      textPages: volumeData.pages.length,
      firstPage: volumeData.pages[0]?.page ?? null,
      lastPage: volumeData.pages.at(-1)?.page ?? null,
      missingScans: volumeData.missingScans,
      scanSourceDir: config.scanDir,
      scanOutputDir: volumeData.scanOutputDir
    };
  }

  await writeText(path.join(distRoot, "index.html"), renderHome(allVolumes));
  await writeText(path.join(distRoot, "build-report.json"), JSON.stringify(report, null, 2));

  console.log(`Built ${allVolumes.reduce((sum, volume) => sum + volume.pages.length, 0)} pages in ${distRoot}`);
  for (const volumeData of allVolumes) {
    console.log(
      `Volume ${volumeData.volume}: ${volumeData.pages.length} text pages, ` +
      `${volumeData.missingScans.length} missing scans`
    );
  }
}

await build();

