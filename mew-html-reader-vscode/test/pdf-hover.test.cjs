const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('native hover offers versioned replacement and preview links without opening a popup', () => {
  const source = fs.readFileSync(require.resolve('../extension.cjs'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('provideHover: (document, position) => {');
  const end = source.indexOf('\n        }\n      })', start);
  class MarkdownString {
    constructor() { this.value = ''; }
    appendMarkdown(value) { this.value += value; }
  }
  const owner = { plans: { token: 7 }, matchingPlans: () => [{ index: 2,
    plan: { title: '替换 [文字]', edits: [{ text: 'RIGHT' }] } }] };
  const hover = vm.runInNewContext('({' + source.slice(start, end).replace('(document, position) =>', 'function(document, position)') + '\n}})', {
    vscode: { MarkdownString, Range: class {}, Hover: class { constructor(contents) { this.contents = contents; } } }
  }).provideHover.call(owner, {}, {});
  assert.match(hover.contents.value, /\[替换\].*\[预览\]/);
  const links = [...hover.contents.value.matchAll(/command:mewReader.reviewPlan\?([^)]*)/g)];
  assert.deepEqual(links.map(link => JSON.parse(decodeURIComponent(link[1]))), [[7, 2, 'apply'], [7, 2, 'preview']]);
  assert.equal(hover.contents.isTrusted.enabledCommands.join(), 'mewReader.reviewPlan');
  owner.matchingPlans = () => [];
  const provider = vm.runInNewContext('({' + source.slice(start, end).replace('(document, position) =>', 'function(document, position)') + '\n}})', { vscode: { Range: class {} } });
  assert.equal(provider.provideHover.call(owner, {}, {}), undefined);
  assert.equal(source.includes('editor.action.showHover'), false);
});


