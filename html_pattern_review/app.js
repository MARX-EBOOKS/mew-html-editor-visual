'use strict';

const element = (identity) => document.getElementById(identity);
const state = { files: [], patterns: [], root: '', path: null, document: null, visible: [], hits: [], hit: -1, request: 0, marks: {}, listPage: 0, reviewable: true, kinds: {} };
const pageSize = 150;
const expandedFiles = new Set();
let activeOptions = {};
let regexDirty = false;
const sessionKey = 'html-pattern-review-session';
const filterIds = ['search', 'result-filter', 'pattern', 'kind', 'path-regex', 'hits-only', 'unreviewed'];
window.addEventListener('pagehide', () => {
  try {
    sessionStorage.setItem(sessionKey, JSON.stringify({
      purpose: selectedPurpose(), options: activeOptions, path: state.path,
      filters: Object.fromEntries(filterIds.map(id => [id, element(id).type === 'checkbox' ? element(id).checked : element(id).value])),
    }));
  } catch {}
});
const selectedPurpose = () => Array.from(element('purpose').querySelectorAll('input:checked'), input => input.value).join(',');
function searchParams(values = {}) {
  return new URLSearchParams({ purpose: selectedPurpose(), options: JSON.stringify(activeOptions), ...values });
}
function filteredHits(matches) {
  const pattern = element('pattern').value, kind = element('kind').value;
  let expression;
  try { expression = element('result-filter').value ? new RegExp(element('result-filter').value, 'i') : null; }
  catch { return []; }
  return (matches || []).filter(hit => (!pattern || hit.pattern === pattern)
    && (!kind || (kind === 'pending' ? !hit.decision : hit.kind === kind))
    && (!expression || expression.test(`${hit.text}\n${hit.context}`)));
}

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function progressKey() { return `html-pattern-review:${state.root}:${selectedPurpose()}`; }
function isReviewed(file) { return state.marks[file.path] === file.version; }
function count(file) {
  if (file.matches) return filteredHits(file.matches).length;
  const pattern = element('pattern').value;
  return pattern ? (file.counts[pattern] || 0) : Object.values(file.counts).reduce((sum, value) => sum + value, 0);
}
const reviewMode = () => state.reviewable;
const pending = (file) => Object.values(file.counts).some(value => value === null);
let comparing = false;
let compareRun = 0;
let scanRequest = 0;
let saving = false;
let proposalEditor;
let proposalModels;
let proposalRun = 0;
let proposalTimer;
let proposalReady = false;
let sourceEditor;
let sourceDecorations;
let sourceComposing = false;
const scanImages = new Map();

function focusScanHighlight() {
  const crops = element('crops');
  const highlight = crops.querySelector('.scan-highlight');
  if (!highlight) return;
  const viewport = crops.getBoundingClientRect(), target = highlight.getBoundingClientRect();
  crops.scrollLeft += target.left + target.width / 2 - viewport.left - crops.clientLeft - crops.clientWidth / 2;
  crops.scrollTop += target.top + target.height / 2 - viewport.top - crops.clientTop - crops.clientHeight / 2;
}

document.querySelector('.scan-reference summary').addEventListener('click', event => {
  event.preventDefault();
  document.querySelector('.scan-reference').open = true;
  requestAnimationFrame(focusScanHighlight);
});

function selectedAction() {
  const choice = document.querySelector('[name="choice"]:checked')?.value;
  return state.document?.actions.find(action => action.id === choice);
}

function decisionText() {
  return selectedAction()?.input === 'source' ? sourceEditor.getValue() : element('custom-text').value;
}

function locateSource() {
  const hit = state.hits[state.hit], model = sourceEditor?.getModel();
  if (!hit || !model) return;
  const characters = Array.from(state.document.source);
  const start = model.getPositionAt(characters.slice(0, hit.start).join('').length);
  const end = model.getPositionAt(characters.slice(0, hit.end).join('').length);
  const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
  sourceEditor.setSelection(range);
  sourceEditor.revealRangeInCenter(range);
  sourceDecorations.set([{ range, options: { inlineClassName: 'source-match' } }]);
}

function mountSourceEditor() {
  const custom = selectedAction()?.input === 'source';
  const inReview = element('show-review').getAttribute('aria-pressed') === 'true';
  (custom && inReview ? element('custom-source-slot') : element('source-pane')).append(element('source'));
  sourceEditor?.updateOptions({ readOnly: !custom || saving, domReadOnly: !custom || saving });
  sourceEditor?.layout();
}

function queueCustomProposal(composing = false) {
  ++proposalRun;
  proposalReady = false;
  element('save').disabled = true;
  element('proposal-diff').hidden = true;
  element('proposal-status').textContent = '正在更新修改提案…';
  clearTimeout(proposalTimer);
  if (!composing) proposalTimer = setTimeout(updateProposal, 300);
}

async function initProposalEditor() {
  if (typeof window.require !== 'function') throw new Error('Monaco 未加载，请在项目目录运行 npm install 后刷新。');
  window.require.config({ paths: { vs: '/monaco' } });
  await new Promise((resolve, reject) => window.require(['vs/editor/editor.main'], resolve, reject));
  monaco.editor.setTheme(element('theme').value === 'light' ? 'vs' : 'vs-dark');
  sourceEditor = monaco.editor.create(element('source'), {
    value: '', language: 'html', readOnly: true, domReadOnly: true,
    ariaLabel: 'HTML source', automaticLayout: true, minimap: { enabled: false },
    wordWrap: 'on', scrollBeyondLastLine: false, fontSize: 13, lineHeight: 21,
  });
  sourceDecorations = sourceEditor.createDecorationsCollection();
  sourceEditor.onDidChangeModelContent(() => {
    if (selectedAction()?.input === 'source' && !sourceEditor.getOption(monaco.editor.EditorOption.readOnly)) {
      sourceDecorations.clear();
      queueCustomProposal(sourceComposing);
    }
  });
  sourceEditor.onDidCompositionStart(() => { sourceComposing = true; queueCustomProposal(true); });
  sourceEditor.onDidCompositionEnd(() => { sourceComposing = false; queueCustomProposal(); });
  proposalEditor = monaco.editor.createDiffEditor(element('proposal-diff'), {
    renderSideBySide: false,
    readOnly: true,
    originalEditable: false,
    domReadOnly: true,
    automaticLayout: true,
    hideUnchangedRegions: { enabled: true, minimumLineCount: 3, contextLineCount: 1, revealLineCount: 5 },
    experimental: { useTrueInlineView: true, showEmptyDecorations: true },
    renderIndicators: true,
    glyphMargin: true,
    renderMarginRevertIcon: false,
    ignoreTrimWhitespace: false,
    diffAlgorithm: 'advanced',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    diffWordWrap: 'on',
    stopRenderingLineAfter: -1,
    renderLineHighlight: 'none',
    fontSize: 13,
    lineHeight: 21,
    padding: { top: 4, bottom: 4 },
    stickyScroll: { enabled: false },
    accessibilityVerbose: true,
  });
  proposalEditor.onDidUpdateDiff(() => {
    requestAnimationFrame(centerProposal);
  });
}

function centerProposal() {
  const editor = proposalEditor.getModifiedEditor();
  const change = proposalEditor.getLineChanges()?.[0];
  if (!change) return;
  const character = change.charChanges?.[0];
  editor.revealPositionInCenter({
    lineNumber: Math.max(1, character?.modifiedStartLineNumber || change.modifiedStartLineNumber),
    column: Math.max(1, character?.modifiedStartColumn || 1),
  }, monaco.editor.ScrollType.Immediate);
}

function showProposal(source) {
  if (!proposalEditor) return;
  const original = state.document?.source || '';
  // Preserve the text; Monaco wraps it to the current viewport and marks exact edits.
  proposalEditor.updateOptions({ lineNumbers: 'off' });
  element('proposal-diff').setAttribute('aria-label', 'HTML 精确文字差异与可展开上下文');
  const previous = proposalModels;
  proposalModels = {
    original: monaco.editor.createModel(original, 'html'),
    modified: monaco.editor.createModel(source, 'html'),
  };
  proposalEditor.setModel(proposalModels);
  // Monaco releases its previous diff view model on the next task. Keep its
  // text models alive until that cancellation has completed.
  setTimeout(() => { previous?.original.dispose(); previous?.modified.dispose(); }, 0);
}

async function updateProposal() {
  clearTimeout(proposalTimer);
  const run = ++proposalRun;
  proposalReady = false;
  element('save').disabled = true;
  const hit = state.hits[state.hit];
  const choice = document.querySelector('[name="choice"]:checked')?.value;
  element('proposal-diff').hidden = true;
  if (!hit || !choice || regexDirty) {
    proposalEditor?.setModel(null);
    const previous = proposalModels;
    setTimeout(() => { previous?.original.dispose(); previous?.modified.dispose(); }, 0);
    proposalModels = null;
    element('proposal-status').textContent = regexDirty ? '搜索条件已修改，请点击“搜索 / 更新提案”。'
      : hit ? '此项没有可应用的修改提案。' : '选择差异以查看修改提案。';
    return;
  }
  element('proposal-status').textContent = '正在生成修改提案…';
  try {
    const data = await api('/api/proposal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: state.path, purpose: selectedPurpose(),
        version: state.document.version, id: hit.id, choice, options: activeOptions, text: decisionText() }),
    });
    if (run !== proposalRun) return;
    showProposal(data.source);
    const changed = data.source !== state.document.source;
    element('proposal-diff').hidden = !changed;
    if (changed) { proposalEditor.layout(); requestAnimationFrame(centerProposal); }
    element('proposal-status').textContent = changed
      ? '红删绿增 · 点击箭头展开上下文，双击隐藏行数展开全部。'
      : '此提案与当前代码相同，没有修改。';
    proposalReady = changed || (selectedAction()?.input !== 'source' && !state.document.configurableActions?.includes(choice));
    element('save').disabled = saving || !proposalReady;
  } catch (error) {
    if (run === proposalRun) element('proposal-status').textContent = `无法生成提案：${error.message}`;
  }
}

function updateNavigation() {
  const index = state.visible.findIndex((file) => file.path === state.path);
  element('previous').disabled = index <= 0;
  element('next').disabled = index < 0 || index >= state.visible.length - 1;
  element('position').textContent = index < 0 ? '' : `${index + 1} / ${state.visible.length}`;
  element('reviewed').disabled = !state.document;
  const reviewed = state.document && isReviewed(state.document);
  element('reviewed').textContent = reviewed ? '✓ 已审阅 · 撤销' : '标记已审阅';
  for (const action of state.document?.navigation || []) {
    const button = element(`hit-${action.id}`);
    if (button) button.disabled = !state.hits.length || saving || (action.step < 0
      ? state.hit === 0 && index <= 0
      : state.hit === state.hits.length - 1 && index >= state.visible.length - 1);
  }
}

// Commas inside brace alternatives or character classes belong to the glob.
function splitPathPatterns(value) {
  let depth = 0, inClass = false, start = 0;
  const patterns = [];
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (!inClass && char === '{') depth++;
    else if (!inClass && char === '}') depth = Math.max(0, depth - 1);
    else if (!inClass && !depth && char === ',') {
      patterns.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  return [...patterns, value.slice(start).trim()].filter(Boolean);
}

function pathGlobSource(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index++;
        if (pattern[index + 1] === '/') { source += '(?:.*/)?'; index++; }
        else source += '.*';
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else if (char === '{' && pattern.indexOf('}', index + 1) !== -1) {
      let end = index + 1, depth = 1;
      for (; end < pattern.length; end++) {
        if (pattern[end] === '{') depth++;
        if (pattern[end] === '}' && --depth === 0) break;
      }
      if (end < pattern.length) {
        source += `(?:${splitPathPatterns(pattern.slice(index + 1, end)).map(pathGlobSource).join('|')})`;
        index = end;
      } else source += '\\{';
    } else if (char === '[' && pattern.indexOf(']', index + 1) > index + 1) {
      const end = pattern.indexOf(']', index + 1);
      const contents = pattern.slice(index + 1, end);
      const characterClass = `[${contents.replace(/^!/, '^')}]`;
      try { new RegExp(characterClass); source += `(?!/)${characterClass}`; }
      catch { source += `\\[${pathGlobSource(contents)}\\]`; }
      index = end;
    } else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return source;
}

function pathFilter(value) {
  const patterns = splitPathPatterns(value.replace(/\\/g, '/')).map(pattern => {
    const exclude = pattern.startsWith('!');
    const text = (exclude ? pattern.slice(1) : pattern).replace(/^\.\//, '').replace(/\/+$/, '');
    // Plain text retains filename/folder substring search; globs match path segments.
    const match = /[*?{[]/.test(text)
      ? new RegExp(`(?:^|/)${pathGlobSource(text)}(?:/.*)?$`, 'i')
      : null;
    return { exclude, matches: path => match ? match.test(path) : path.toLowerCase().includes(text.toLowerCase()) };
  });
  const includes = patterns.filter(pattern => !pattern.exclude);
  const excludes = patterns.filter(pattern => pattern.exclude);
  return path => (!includes.length || includes.some(pattern => pattern.matches(path)))
    && !excludes.some(pattern => pattern.matches(path));
}

function renderFiles(pageOverride = null) {
  let matchesPath;
  try {
    const query = element('search').value;
    const expression = element('path-regex').checked ? new RegExp(query, 'i') : null;
    if (element('result-filter').value) new RegExp(element('result-filter').value, 'i');
    matchesPath = expression ? path => expression.test(path) : pathFilter(query);
    element('filter-error').hidden = true;
  } catch (error) {
    element('filter-error').textContent = `正则错误：${error.message}`;
    element('filter-error').hidden = false;
    matchesPath = () => false;
  }
  state.visible = state.files.filter((file) => matchesPath(file.path)
    && (!element('result-filter').value || !file.matches || count(file) > 0)
    && (!element('hits-only').checked || count(file) > 0 || (reviewMode() && pending(file)))
    && (!element('unreviewed').checked || !isReviewed(file)));
  const fragment = document.createDocumentFragment();
  const selected = state.visible.findIndex((file) => file.path === state.path);
  const pageCount = Math.max(1, Math.ceil(state.visible.length / pageSize));
  state.listPage = pageOverride === null ? Math.max(0, Math.floor(selected / pageSize)) : Math.max(0, Math.min(pageCount - 1, pageOverride));
  element('file-page').textContent = `${state.listPage + 1} / ${pageCount} 页`;
  element('files-back').disabled = state.listPage === 0;
  element('files-forward').disabled = state.listPage >= pageCount - 1;
  for (const file of state.visible.slice(state.listPage * pageSize, (state.listPage + 1) * pageSize)) {
    const button = document.createElement('button');
    button.className = `file${file.path === state.path ? ' active' : ''}`;
    button.setAttribute('aria-current', file.path === state.path ? 'true' : 'false');
    const label = document.createElement('span');
    const slash = file.path.lastIndexOf('/');
    label.textContent = file.path.slice(slash + 1);
    const directory = document.createElement('small');
    directory.className = 'file-directory';
    directory.textContent = slash < 0 ? '' : file.path.slice(0, slash);
    button.title = file.path;
    const toggle = document.createElement('button');
    toggle.className = 'file-toggle';
    toggle.textContent = expandedFiles.has(file.path) ? '⌄' : '›';
    toggle.setAttribute('aria-label', `展开 / 折叠 ${file.path}`);
    toggle.setAttribute('aria-expanded', String(expandedFiles.has(file.path)));
    toggle.addEventListener('click', () => {
      if (expandedFiles.has(file.path)) { expandedFiles.delete(file.path); renderFiles(state.listPage); }
      else { expandedFiles.add(file.path); openFile(file.path); }
    });
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = file.error ? '出错' : `${isReviewed(file) ? '✓ ' : ''}${reviewMode() && pending(file) ? '待比较' : count(file)}`;
    button.append(label, directory, badge);
    button.addEventListener('click', () => openFile(file.path));
    const row = document.createElement('div');
    row.className = 'file-row';
    row.append(toggle, button);
    fragment.append(row);
    if (expandedFiles.has(file.path) && file.matches) {
      const children = document.createElement('div');
      children.className = 'file-matches';
      for (const hit of filteredHits(file.matches)) {
        const child = document.createElement('button');
        const selected = state.path === file.path && state.hits[state.hit]?.start === hit.start
          && state.hits[state.hit]?.end === hit.end && state.hits[state.hit]?.pattern === hit.pattern;
        child.className = `file-hit${selected ? ' active' : ''}`;
        child.setAttribute('aria-current', String(selected));
        const location = document.createElement('span');
        location.className = 'hit-line';
        location.textContent = `${hit.line}: `;
        const context = hit.context || '';
        const before = Number.isInteger(hit.context_start)
          ? Array.from(context).slice(0, hit.start - hit.context_start).join('').length
          : hit.text ? context.indexOf(hit.text) : -1;
        const mark = document.createElement('mark');
        mark.textContent = hit.text.replace(/\s+/g, ' ') || '↦';
        child.append(location);
        if (before >= 0) child.append(document.createTextNode(context.slice(0, before).replace(/\s+/g, ' ')),
          mark, document.createTextNode(context.slice(before + hit.text.length).replace(/\s+/g, ' ')));
        else child.append(document.createTextNode(context.replace(/\s+/g, ' ').trim() || '↦'));
        child.title = hit.text;
        child.addEventListener('click', async () => {
          if (state.path !== file.path || !state.document) await openFile(file.path);
          if (state.path !== file.path || !state.document) return;
          const index = state.hits.findIndex(item => item.start === hit.start && item.end === hit.end && item.pattern === hit.pattern);
          if (index >= 0) selectHit(index);
        });
        children.append(child);
      }
      fragment.append(children);
    }
  }
  if (!state.visible.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '没有符合条件的文件。试试清除筛选或重新扫描。';
    fragment.append(empty);
  }
  element('files').replaceChildren(fragment);
  const filters = ['search', 'result-filter', 'pattern', 'kind'].filter(id => element(id).value).length
    + ['path-regex', 'hits-only', 'unreviewed'].filter(id => element(id).checked).length;
  element('filter-count').textContent = filters ? `（${filters} 项生效）` : '';
  element('reset-filters').disabled = !filters;
  element('summary').textContent = `${state.visible.length} 文件中有 ${state.visible.reduce((sum, file) => sum + count(file), 0)} 个结果${state.visible.some(pending) ? (comparing ? ' · 正在比较…' : ' · 有文件待比较') : ''}`;
  updateNavigation();
}

function setView(view) {
  if (typeof view === 'boolean') view = view ? 'preview' : 'source';
  element('source-pane').hidden = view !== 'source';
  element('preview').hidden = view !== 'preview';
  element('review-pane').hidden = view !== 'review';
  element('originals-pane').hidden = view !== 'originals';
  for (const name of ['source', 'preview', 'review', 'originals']) element(`show-${name}`).setAttribute('aria-pressed', String(view === name));
  if (view === 'originals') void renderOriginalPages();
  if (view === 'review') proposalEditor?.layout();
  mountSourceEditor();
  if (view === 'source') locateSource();
}

async function renderOriginalPages() {
  const pane = element('originals-pane'), doc = state.document;
  if (!doc) { pane.textContent = '选择文件后查看整页原图。'; return; }
  const key = JSON.stringify([doc.path, doc.version]);
  if (pane.dataset.key === key) return;
  pane.dataset.key = key;
  pane.textContent = '正在加载整页原图…';
  const current = () => state.document?.path === doc.path && state.document?.version === doc.version && pane.dataset.key === key;
  try {
    const pages = await api(`/api/pages?${new URLSearchParams({ path: doc.path, version: doc.version })}`);
    if (!current()) return;
    const fragment = document.createDocumentFragment();
    for (const page of pages) {
      const figure = document.createElement('figure'), caption = document.createElement('figcaption');
      caption.textContent = `PDF ${page.label} · 物理页 ${page.page}`;
      figure.append(caption);
      for (const scan of page.images) {
        const image = document.createElement('img');
        image.alt = `扫描原图，PDF 第 ${page.label} 页`;
        image.loading = 'lazy';
        image.width = scan.width;
        image.height = scan.height;
        image.src = scan.src;
        image.onerror = () => { image.alt = `PDF ${page.label} · 无法加载原图，请重新打开文件。`; };
        figure.append(image);
      }
      if (!page.images.length) figure.append(document.createTextNode('该页没有可用的内嵌扫描原图。'));
      fragment.append(figure);
    }
    pane.replaceChildren(fragment);
  } catch (error) {
    if (!current()) return;
    delete pane.dataset.key;
    pane.textContent = `无法加载整页原图：${error.message}`;
  }
}

function selectHit(index) {
  if (!state.hits.length) return;
  state.hit = Math.max(0, Math.min(index, state.hits.length - 1));
  const hit = state.hits[state.hit];
  setView(reviewMode() ? 'review' : 'source');
  renderReview(hit);
  locateSource();
  Array.from(element('matches').children).forEach((button, buttonIndex) => button.classList.toggle('active', buttonIndex === state.hit));
  element('matches').children[state.hit]?.scrollIntoView({ block: 'nearest' });
  element('status').textContent = `${state.document.encoding} · 结果 ${state.hit + 1} / ${state.hits.length} · 第 ${hit.line} 行，第 ${hit.column} 列`;
  renderFiles(state.listPage);
}

function renderDocument() {
  element('originals-pane').replaceChildren();
  delete element('originals-pane').dataset.key;
  state.hits = filteredHits(state.document?.matches);
  state.hit = -1;
  element('match-count').textContent = `(${state.hits.length})`;
  const fragment = document.createDocumentFragment();
  state.hits.forEach((hit, index) => {
    const button = document.createElement('button');
    button.className = 'match';
    const title = document.createElement('span');
    title.textContent = reviewMode() ? `${state.patterns.find(p => p.id === hit.pattern)?.label || hit.pattern} · ${state.kinds[hit.kind] || hit.kind || ''}`
      : state.patterns.find((item) => item.id === hit.pattern)?.label || hit.pattern;
    const location = document.createElement('small');
    location.textContent = `第 ${hit.line} 行，第 ${hit.column} 列`;
    const context = document.createElement('code');
    context.textContent = hit.context;
    button.append(title, location, context);
    button.addEventListener('click', () => selectHit(index));
    fragment.append(button);
  });
  if (!state.hits.length) fragment.append(document.createTextNode(state.document ? '当前筛选下没有结果。可清除筛选查看全部。' : '从左侧选择文件开始审阅。'));
  element('matches').replaceChildren(fragment);
  renderReview(null);
  element('show-review').hidden = !reviewMode();
  element('kind-label').hidden = !reviewMode();
  element('compare').hidden = !reviewMode();
  setView(reviewMode() ? 'review' : 'source');
  element('status').textContent = state.document ? `${state.document.encoding} · ${state.hits.length} 个结果` : '';
  if (state.hits.length) selectHit(0);
  else if (reviewMode()) element('diff-location').textContent = state.document ? '当前筛选下没有差异。' : '选择文件后查看审阅结果。';
}

function renderReview(hit) {
  clearTimeout(proposalTimer);
  sourceComposing = false;
  sourceEditor.updateOptions({ readOnly: true, domReadOnly: true });
  sourceDecorations.clear();
  sourceEditor.setValue(state.document?.source || '');
  element('choices').disabled = !hit || saving;
  element('save').disabled = true;
  element('save').textContent = '应用并保存';
  element('save-status').textContent = '';
  element('custom-text').hidden = true;
  element('custom-text').value = hit?.text || '';
  const options = element('decision-options');
  options.replaceChildren();
  const navigation = element('hit-navigation');
  navigation.replaceChildren();
  for (const action of state.document?.navigation || []) {
    const button = document.createElement('button');
    button.id = `hit-${action.id}`;
    button.textContent = action.label;
    button.addEventListener('click', () => submitDecision(action.id));
    navigation.append(button);
  }
  updateNavigation();
  for (const action of state.document?.actions || []) {
    if (!hit || (hit.choices && !hit.choices.includes(action.id))) continue;
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'choice';
    input.value = action.id;
    input.addEventListener('change', () => {
      element('custom-text').hidden = action.input !== 'text';
      if (action.input === 'text') element('custom-text').focus();
      mountSourceEditor();
      if (action.input === 'source') { locateSource(); sourceEditor.focus(); }
      void updateProposal();
    });
    label.append(input, document.createTextNode(action.label));
    options.append(label);
  }
  element('choices').hidden = !options.children.length;
  const firstChoice = options.querySelector('input');
  if (firstChoice) {
    firstChoice.checked = true;
    const action = state.document.actions.find(action => action.id === firstChoice.value);
    element('custom-text').hidden = action.input !== 'text';
  }
  mountSourceEditor();
  void updateProposal();
  element('diff-location').textContent = hit ? `差异 ${state.hit + 1} / ${state.hits.length} · 行 ${hit.line}${Number.isFinite(hit.alignment ?? state.document.alignment) ? ` · 相似度 ${Math.round((hit.alignment ?? state.document.alignment) * 100)}%` : ''}` : '';
  document.querySelector('.scan-reference').hidden = !hit?.crops?.length;
  document.querySelector('.review-actions').hidden = !options.children.length;
  const crops = element('crops');
  crops.replaceChildren();
  if (!hit || !reviewMode()) return;
  const pages = new Map();
  for (const [index, crop] of (hit.crops || []).entries()) {
    if (!pages.has(crop.page)) pages.set(crop.page, []);
    pages.get(crop.page).push({ crop, index });
  }
  for (const [page, entries] of pages) {
    const key = `${state.document.pdf}:${page}`;
    let view = scanImages.get(key);
    if (!view) {
      const figure = document.createElement('figure'), caption = document.createElement('figcaption');
      const scan = document.createElement('div'), image = document.createElement('img');
      scan.className = 'scan-image';
      image.alt = `扫描原图，PDF 第 ${entries[0].crop.label} 页`;
      scan.append(image);
      figure.append(caption, scan);
      view = { figure, caption, scan, image };
      scanImages.set(key, view);
      if (scanImages.size > 12) scanImages.delete(scanImages.keys().next().value);
    }
    const { figure, caption, scan, image } = view;
    const run = view.run = {};
    scan.querySelectorAll('.scan-highlight').forEach(node => node.remove());
    caption.textContent = `PDF ${entries[0].crop.label} · 物理页 ${page}`;
    crops.append(figure);
    const focus = () => {
      if (view.run !== run || state.hits[state.hit] !== hit || !crops.contains(figure)) return;
      focusScanHighlight();
    };
    image.onload = focus;
    image.onerror = () => { caption.textContent += ' · 无法显示扫描原图。'; };
    void Promise.all(entries.map(({ index }) => api(`/api/crop?${new URLSearchParams({
      path: state.path, version: state.document.version, id: hit.original_id ?? hit.id,
      index, purpose: hit.purpose || selectedPurpose(), geometry: '1',
    })}`))).then(regions => {
      if (view.run !== run || state.hits[state.hit] !== hit || !crops.contains(figure)) return;
      const data = regions[0];
      scan.style.width = `${data.width * .75}px`;
      scan.style.height = `${data.height * .75}px`;
      for (const region of regions) {
        const [left, top, width, height] = region.highlight;
        const highlight = document.createElement('span');
        highlight.className = `scan-highlight${region.anchor ? ' anchor' : ''}`;
        highlight.setAttribute('aria-hidden', 'true');
        Object.assign(highlight.style, { left: `${left / data.width * 100}%`, top: `${top / data.height * 100}%`,
          width: `${Math.max(2, width) / data.width * 100}%`, height: `${Math.max(2, height) / data.height * 100}%` });
        scan.append(highlight);
      }
      caption.title = entries.map(({ crop }) => crop.bbox.map(n => n.toFixed(1)).join(', ')).join(' / ');
      caption.textContent += data.anchor ? ' · 虚线框为相邻 OCR 定位参考' : ' · 黄框为当前差异';
      if (image.getAttribute('src') !== data.image) image.src = data.image;
      else if (image.complete) requestAnimationFrame(focus);
    }).catch(error => {
      if (view.run === run && crops.contains(figure)) caption.textContent += ` · 无法定位：${error.message}`;
    });
  }
  if (!hit.crops?.length) crops.textContent = '该位置没有可用的 OCR 坐标。';
}

function rememberDocument(data) {
  const file = state.files.find(file => file.path === data.path);
  if (file) { file.matches = data.matches; file.counts = Object.fromEntries(state.patterns.map(p => [p.id, data.matches.filter(h => h.pattern === p.id).length])); file.version = data.version; delete file.error; }
}

async function openFile(path) {
  const request = ++state.request;
  state.path = path;
  expandedFiles.add(path);
  state.document = null;
  element('filename').textContent = path;
  element('preview').removeAttribute('src');
  renderDocument();
  renderFiles();
  element('status').textContent = '正在加载文件…';
  try {
    const data = await api(`/api/document?${searchParams({ path })}`);
    if (request !== state.request) return;
    state.document = data;
    rememberDocument(data);
    element('preview').src = `/api/preview?path=${encodeURIComponent(path)}`;
    renderDocument();
    renderFiles();
  } catch (error) {
    if (request === state.request) element('status').textContent = error.message;
  }
}

function moveFile(direction) {
  const index = state.visible.findIndex((file) => file.path === state.path);
  const next = state.visible[index + direction];
  if (next) openFile(next.path);
}

function applyFilters() {
  renderFiles();
  if (!state.visible.some((file) => file.path === state.path)) {
    if (state.visible.length) openFile(state.visible[0].path);
    else {
      ++state.request;
      state.path = null;
      state.document = null;
      element('filename').textContent = '没有符合筛选的文件';
      element('preview').removeAttribute('src');
      renderDocument();
      updateNavigation();
    }
  } else {
    const hits = filteredHits(state.document?.matches);
    // Path-only filtering must not reset the selection or an in-progress edit.
    if (hits.length !== state.hits.length || hits.some((hit, index) => hit !== state.hits[index])) renderDocument();
  }
}

async function rescan(session = null) {
  const scanRun = ++scanRequest;
  ++compareRun;
  const purpose = selectedPurpose();
  comparing = false;
  element('compare').textContent = '比较当前筛选的文件';
  ++state.request;
  state.document = null;
  state.hits = [];
  state.files = [];
  state.visible = [];
  renderDocument();
  renderFiles();
  element('refresh').disabled = true;
  element('status').textContent = '正在扫描 HTML 文件…';
  try {
    const data = await api(`/api/files?${searchParams({ reuse: session ? '1' : '0' })}`);
    if (scanRun !== scanRequest || purpose !== selectedPurpose()) return;
    state.reviewable = data.reviewable;
    element('regex-controls').hidden = !data.configurable;
    state.kinds = data.kinds;
    element('kind').replaceChildren(new Option('全部结果', ''), ...Object.entries(data.kinds).map(([id, label]) => new Option(label, id)), new Option('尚未处理', 'pending'));
    state.files = data.files;
    state.patterns = data.patterns;
    state.root = data.root;
    element('root').textContent = data.root;
    element('root').title = data.configPath || '';
    try { state.marks = JSON.parse(localStorage.getItem(progressKey()) || '{}') || {}; }
    catch { state.marks = {}; }
    const selectedPattern = element('pattern').value;
    element('pattern').replaceChildren(new Option('全部规则', ''));
    for (const pattern of state.patterns) element('pattern').add(new Option(pattern.label, pattern.id));
    if (state.patterns.some((pattern) => pattern.id === selectedPattern)) element('pattern').value = selectedPattern;
    if (session) {
      state.path = session.path;
      for (const id of filterIds) {
        if (session.filters?.[id] === undefined) continue;
        if (element(id).type === 'checkbox') element(id).checked = session.filters[id];
        else element(id).value = session.filters[id];
      }
    }
    renderFiles();
    const path = state.visible.find((file) => file.path === state.path)?.path || state.visible[0]?.path;
    if (path) await openFile(path);
    else applyFilters();
    if (!data.restored && scanRun === scanRequest && purpose === selectedPurpose() && reviewMode()) void compareFiles(false);
  } catch (error) {
    if (scanRun === scanRequest && purpose === selectedPurpose()) {
      element('status').textContent = error.message;
      element('summary').textContent = `加载失败：${error.message}`;
    }
  }
  finally {
    if (scanRun === scanRequest && purpose === selectedPurpose()) element('refresh').disabled = false;
  }
}

element('reset-filters').addEventListener('click', () => {
  for (const id of ['search', 'result-filter', 'pattern', 'kind']) element(id).value = '';
  for (const id of ['path-regex', 'hits-only', 'unreviewed']) element(id).checked = false;
  applyFilters();
});
element('toggle-findings').addEventListener('click', () => {
  const panel = element('findings');
  panel.hidden = !panel.hidden;
  element('toggle-findings').setAttribute('aria-expanded', String(!panel.hidden));
});
element('search').addEventListener('input', applyFilters);
element('result-filter').addEventListener('input', applyFilters);
element('path-regex').addEventListener('change', applyFilters);
for (const identity of ['pattern', 'kind', 'hits-only', 'unreviewed']) element(identity).addEventListener('change', applyFilters);
element('purpose').addEventListener('change', (event) => {
  if (!selectedPurpose()) { event.target.checked = true; return; }
  regexDirty = false;
  activeOptions = { query: element('regex-query').value, replacement: element('regex-replacement').value,
    flags: ['i', 'm', 's'].filter(flag => element(`regex-${flag}`).checked).join('') };
  state.document = null;
  expandedFiles.clear();
  rescan();
});
element('regex-run').addEventListener('click', () => {
  regexDirty = false;
  activeOptions = { query: element('regex-query').value, replacement: element('regex-replacement').value,
    flags: ['i', 'm', 's'].filter(flag => element(`regex-${flag}`).checked).join('') };
  state.document = null;
  rescan();
});
for (const id of ['regex-query', 'regex-replacement', 'regex-i', 'regex-m', 'regex-s']) {
  element(id).addEventListener('input', () => {
    regexDirty = true;
    ++proposalRun;
    clearTimeout(proposalTimer);
    proposalReady = false;
    element('save').disabled = true;
    element('proposal-diff').hidden = true;
    element('proposal-status').textContent = '搜索条件已修改，请点击“搜索 / 更新提案”。';
  });
}
for (const id of ['regex-query', 'regex-replacement']) element(id).addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); element('regex-run').click(); }
});
element('show-review').addEventListener('click', () => setView('review'));
element('theme').addEventListener('change', () => {
  document.documentElement.dataset.theme = element('theme').value;
  if (proposalEditor) monaco.editor.setTheme(element('theme').value === 'light' ? 'vs' : 'vs-dark');
  try { localStorage.setItem('html-review-theme', element('theme').value); } catch {}
});
try { element('theme').value = localStorage.getItem('html-review-theme') || 'dark'; } catch {}
document.documentElement.dataset.theme = element('theme').value;
async function submitDecision(choice) {
  const hit = state.hits[state.hit];
  if (!hit || !choice || saving) return;
  if (!state.document.navigation.some(action => action.id === choice) && (!proposalReady || regexDirty)) return;
  const path = state.path, request = state.request, index = state.hit;
  saving = true;
  mountSourceEditor();
  element('choices').disabled = true;
  element('save').disabled = true;
  updateNavigation();
  try {
    const data = await api('/api/decision', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, purpose: selectedPurpose(), version: state.document.version, id: hit.id, choice, options: activeOptions, text: decisionText() }) });
    if (request !== state.request) return;
    state.document = data;
    rememberDocument(data);
    saving = false;
    renderDocument();
    const step = data.decisionResult?.step || (data.decisionResult?.advance ? 1 : 0);
    const nextIndex = index + step;
    if (state.hits.length) selectHit(Math.max(0, Math.min(nextIndex, state.hits.length - 1)));
    element('preview').src = `/api/preview?path=${encodeURIComponent(path)}&v=${data.version}`;
    renderFiles();
    if (step && (nextIndex < 0 || nextIndex >= state.hits.length)) {
      const nextFile = state.visible[state.visible.findIndex(file => file.path === path) + Math.sign(step)];
      if (nextFile) {
        await openFile(nextFile.path);
        if (step < 0 && state.hits.length) selectHit(state.hits.length - 1);
      }
    }
  } catch (error) { if (request === state.request) element('save-status').textContent = error.message; }
  finally {
    saving = false;
    mountSourceEditor();
    element('choices').disabled = !state.hits.length;
    element('save').disabled = !proposalReady || regexDirty;
    updateNavigation();
  }
}
element('custom-text').addEventListener('input', (event) => {
  queueCustomProposal(event.isComposing);
});
element('custom-text').addEventListener('compositionstart', () => {
  clearTimeout(proposalTimer);
  ++proposalRun;
  proposalReady = false;
  element('save').disabled = true;
});
element('custom-text').addEventListener('compositionend', () => {
  clearTimeout(proposalTimer);
  proposalTimer = setTimeout(updateProposal, 300);
});
element('save').addEventListener('click', () => submitDecision(document.querySelector('[name="choice"]:checked')?.value));
async function compareFiles(toggle = true) {
  if (comparing) {
    if (toggle) {
      ++compareRun;
      comparing = false;
      element('compare').textContent = '比较当前筛选的文件';
      renderFiles();
    }
    return;
  }
  const run = ++compareRun;
  comparing = true;
  element('compare').textContent = '停止比较';
  const files = [...state.visible];
  const purpose = selectedPurpose();
  let lastRender = 0;
  try {
    for (const [index, file] of files.entries()) {
      if (run !== compareRun || !reviewMode()) break;
      element('summary').textContent = `比较 ${index + 1} / ${files.length} · ${file.path}`;
      try {
        const data = await api(`/api/document?${searchParams({ path: file.path, purpose })}`);
        if (run !== compareRun) break;
        rememberDocument(data);
        if (performance.now() - lastRender > 150) {
          renderFiles(state.listPage);
          lastRender = performance.now();
        }
      } catch (error) { if (run === compareRun) file.error = error.message; }
    }
  } finally {
    if (run === compareRun) {
      comparing = false;
      element('compare').textContent = '比较当前筛选的文件';
      renderFiles();
    }
  }
}
element('compare').addEventListener('click', () => compareFiles());
element('refresh').addEventListener('click', () => rescan());
element('files-back').addEventListener('click', () => renderFiles(state.listPage - 1));
element('files-forward').addEventListener('click', () => renderFiles(state.listPage + 1));
element('previous').addEventListener('click', () => moveFile(-1));
element('next').addEventListener('click', () => moveFile(1));
element('show-source').addEventListener('click', () => setView(false));
element('show-preview').addEventListener('click', () => setView(true));
element('show-originals').addEventListener('click', () => setView('originals'));
element('reviewed').addEventListener('click', () => {
  if (!state.document) return;
  if (isReviewed(state.document)) delete state.marks[state.path];
  else state.marks[state.path] = state.document.version;
  try { localStorage.setItem(progressKey(), JSON.stringify(state.marks)); }
  catch { element('status').textContent = '浏览器存储不可用；审阅标记仅在本次会话有效。'; }
  applyFilters();
});
document.addEventListener('keydown', (event) => {
  if (event.isComposing || saving) return;
  if (event.key === 'F4' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    selectHit(state.hit + (event.shiftKey ? -1 : 1));
    return;
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    moveFile(event.key === 'ArrowLeft' ? -1 : 1);
    return;
  }
  if (event.target.closest('.monaco-editor')) return;
  if (event.ctrlKey || event.metaKey || event.altKey || /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(event.target.tagName)) return;
  const actions = { ArrowLeft: () => moveFile(-1), ArrowRight: () => moveFile(1),
    j: () => selectHit(state.hit + 1), k: () => selectHit(state.hit - 1), r: () => element('reviewed').click() };
  if (actions[event.key]) { event.preventDefault(); actions[event.key](); }
});
async function start() {
  try {
    await initProposalEditor();
    const purposes = await api('/api/providers');
    let session;
    try { session = JSON.parse(sessionStorage.getItem(sessionKey)); } catch {}
    if (!session || typeof session.purpose !== 'string'
      || !session.purpose.split(',').every(id => purposes.some(p => p.id === id))) session = null;
    if (session) {
      activeOptions = session.options || {};
      element('regex-query').value = activeOptions.query || '';
      element('regex-replacement').value = activeOptions.replacement || '';
      for (const flag of ['i', 'm', 's']) element(`regex-${flag}`).checked = (activeOptions.flags || '').includes(flag);
    }
    element('purpose').replaceChildren(Object.assign(document.createElement('legend'), { textContent: '审阅功能（可多选）' }), ...purposes.map((p, index) => {
      const label = document.createElement('label');
      label.className = 'check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = p.id;
      input.checked = session ? session.purpose.split(',').includes(p.id) : index === 0;
      label.append(input, document.createTextNode(p.label));
      return label;
    }));
    if (purposes.length) await rescan(session);
    else element('status').textContent = '后端尚未注册审阅功能。';
  } catch (error) { element('status').textContent = error.message; }
}
start();
