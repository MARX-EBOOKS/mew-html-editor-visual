(() => {
  const key = 'mew-editor-layout-v1';
  const root = document.documentElement;
  const main = document.querySelector('main');
  const defaults = { tree: 220, preview: 340, scale: 1 };
  let saved;
  try { saved = JSON.parse(localStorage.getItem(key)); } catch {}
  const layout = { ...defaults };
  for (const name of Object.keys(defaults)) {
    if (Number.isFinite(saved?.[name])) layout[name] = saved[name];
  }
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const persist = () => { try { localStorage.setItem(key, JSON.stringify(layout)); } catch {} };
  const limits = name => {
    const other = name === 'tree' ? layout.preview : layout.tree;
    return [name === 'tree' ? 140 : 200, Math.max(name === 'tree' ? 140 : 200, main.clientWidth - 332 - other)];
  };
  function render() {
    layout.scale = clamp(layout.scale, .8, 1.6);
    for (const name of ['tree', 'preview']) {
      const [min, max] = limits(name);
      layout[name] = clamp(layout[name], min, max);
      root.style.setProperty(`--${name}-width`, `${layout[name]}px`);
      const splitter = document.getElementById(`${name}Splitter`);
      splitter.setAttribute('aria-valuemin', min);
      splitter.setAttribute('aria-valuemax', max);
      splitter.setAttribute('aria-valuenow', Math.round(layout[name]));
    }
    root.style.setProperty('--toolbar-scale', layout.scale);
    document.getElementById('toolbarReset').textContent = `${Math.round(layout.scale * 100)}%`;
    document.getElementById('toolbarSmaller').disabled = layout.scale <= .8;
    document.getElementById('toolbarLarger').disabled = layout.scale >= 1.6;
    // Existing floating-toolbar bounds must follow changes in pane size too.
    const panel = document.getElementById('tagPanel');
    if (panel.classList.contains('floating')) {
      const pane = panel.parentElement;
      panel.style.left = `${clamp(panel.offsetLeft, 8, Math.max(8, pane.clientWidth - panel.offsetWidth - 8))}px`;
      panel.style.top = `${clamp(panel.offsetTop, 8, Math.max(8, pane.clientHeight - panel.offsetHeight - 8))}px`;
    }
  }
  for (const [id, delta] of [['toolbarSmaller', -.1], ['toolbarLarger', .1], ['toolbarReset', 0]]) {
    document.getElementById(id).addEventListener('click', () => {
      layout.scale = delta ? Math.round((layout.scale + delta) * 10) / 10 : 1;
      render(); persist();
    });
  }
  for (const name of ['tree', 'preview']) {
    const splitter = document.getElementById(`${name}Splitter`);
    const direction = name === 'tree' ? 1 : -1;
    splitter.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const x = event.clientX, width = layout[name];
      splitter.setPointerCapture(event.pointerId);
      splitter.focus();
      splitter.classList.add('dragging');
      document.body.classList.add('resizing');
      const move = e => { layout[name] = width + direction * (e.clientX - x); render(); };
      const end = () => {
        splitter.removeEventListener('pointermove', move);
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) splitter.removeEventListener(type, end);
        if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
        splitter.classList.remove('dragging');
        document.body.classList.remove('resizing');
        persist();
      };
      splitter.addEventListener('pointermove', move);
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) splitter.addEventListener(type, end);
    });
    splitter.addEventListener('dblclick', () => { layout[name] = defaults[name]; render(); persist(); });
    splitter.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const [min, max] = limits(name);
      layout[name] = event.key === 'Home' ? min : event.key === 'End' ? max : layout[name] + (event.key === 'ArrowRight' ? 1 : -1) * direction * (event.shiftKey ? 40 : 10);
      render(); persist();
    });
  }
  document.getElementById('layoutReset').addEventListener('click', () => { Object.assign(layout, defaults); render(); persist(); });
  new ResizeObserver(render).observe(main);
  render();
})();
