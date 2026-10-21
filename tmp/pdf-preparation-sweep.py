from pathlib import Path
p=Path('public/pdfdiff/pdf-selection-diff.js');s=p.read_text(encoding='utf-8')
s=s.replace('''      if (prepared && prepared.pdf === pdf && prepared.full === full && prepared.pages.length === pages.length
        && pages.every((page, i) => page === prepared.pages[i] && source.connections.get(page) === prepared.connections[i])) return;''','''      if (prepared?.pdf === pdf && prepared.full === full && prepared.connections.size === pages.length
        && pages.every(page => prepared.connections.has(page) && source.connections.get(page) === prepared.connections.get(page))) return;''')
a=s.index('      // Prefer whole-passage mappings');b=s.index('      source.preparedPdf = pdf;',a)
s=s[:a]+'''      // Sweep containing passages once; keep the two furthest covers from distinct pages.
      const connections = pages.flatMap(page => (source.connections.get(page) || []).map(item => ({ page, ...item, item })))
        .sort((a, b) => a.start - b.start || b.end - a.end);
      const covers = [], discarded = new Map();
      for (const hit of connections) {
        if (covers.some(other => other.page !== hit.page && other.end >= hit.end
          && other.end - other.start > hit.end - hit.start)) {
          if (!discarded.has(hit.page)) discarded.set(hit.page, new Set());
          discarded.get(hit.page).add(hit.item);
        }
        if (hit.page === full || covers.some(other => other.page === hit.page && other.end >= hit.end)) continue;
        const previous = covers.findIndex(other => other.page === hit.page);
        if (previous >= 0) covers.splice(previous, 1);
        covers.push(hit);
        covers.sort((a, b) => b.end - a.end || a.start - b.start);
        if (covers.length > 2) covers.pop();
      }
      for (const [page, removed] of discarded)
        source.connections.set(page, source.connections.get(page).filter(item => !removed.has(item)));
      source.preparation = { pdf, full, connections: new Map(pages.map(page => [page, source.connections.get(page)])) };
'''+s[b:]
p.write_text(s,encoding='utf-8')
p=Path('public/pdfdiff/pdf-review-provider.js');s=p.read_text(encoding='utf-8')
a=s.index('    const key = [index, enabled, editor.getModel()');b=s.index('\n  }',a)
s=s[:a]+'''    const previous = state.key, model = editor.getModel();
    if (previous?.index === index && previous.enabled === enabled && previous.model === model
      && previous.connections.size === connections.length && connections.every(([item, target]) => {
        const saved = previous.connections.get(item);
        return saved?.target === target && saved.fontVersion === target.fontVersion;
      })) return;
    state.collection.set(enabled && index ? sourceDecorations(index, connections, model) : []);
    state.key = { index, enabled, model, connections: new Map(connections.map(([item, target]) =>
      [item, { target, fontVersion: target.fontVersion }])) };'''+s[b:]
p.write_text(s,encoding='utf-8')
print('engine',len(Path('public/pdfdiff/pdf-selection-diff.js').read_text(encoding='utf-8').splitlines()))
