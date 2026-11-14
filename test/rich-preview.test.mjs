import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

/**
 * The renderer only needs a tiny DOM surface: createElement, fragments,
 * append, textContent and classList. This stub serializes back to a compact
 * markup string so structure assertions stay readable.
 */
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.textValue = '';
    this.isText = false;
    this.className = '';
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.parentElement = null;
  }
  get childNodes() { return this.children; }
  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      if (typeof node !== 'object') {
        const text = new FakeNode('#text');
        text.textValue = String(node);
        text.isText = true;
        this.children.push(text);
      } else {
        node.parentElement = this;
        this.children.push(node);
      }
    }
  }
  get textContent() { return this.isText ? this.textValue : this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.children = []; this.textValue = String(value); this.isText = true; }
  get classList() {
    const node = this;
    return {
      add(...names) { const set = new Set(node.className.split(' ').filter(Boolean)); names.forEach(name => set.add(name)); node.className = [...set].join(' '); },
      contains(name) { return node.className.split(' ').includes(name); },
    };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
}

function serialize(node) {
  if (!node || node.isText) return node?.textValue ?? '';
  const tag = node.tagName.toLowerCase();
  const mark = node.className ? `${tag}.${node.className.replaceAll(' ', '.')}` : tag;
  return `<${mark}>${node.children.map(serialize).join('')}</${tag}>`;
}

function collect(node, tagName, found = []) {
  for (const child of node.children ?? []) {
    if (child.tagName === tagName.toUpperCase()) found.push(child);
    collect(child, tagName, found);
  }
  return found;
}

async function loadModule(relative, extraGlobals = {}) {
  const document = {
    createElement: tag => new FakeNode(tag),
    createDocumentFragment: () => new FakeNode('#fragment'),
  };
  const context = vm.createContext({ document, ...extraGlobals });
  const source = (await fs.readFile(new URL(relative, import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '')
    .replace(/^export \{[^}]*\};\n/gm, '')
    .replace(/^export (?=const |let |function |class )/gm, '');
  vm.runInContext(source, context);
  return context;
}

test('markdown renders headings, emphasis, code, links and lists', async () => {
  const { renderMarkdown } = await loadModule('../web/markdown.js');
  const tree = renderMarkdown('# 标题\n\n一段 **加粗** 与 *斜体* 与 `code` 与 [链接](https://example.com)\n\n- 第一项\n- 第二项\n  - 嵌套\n\n1. 甲\n2. 乙\n\n- [x] 已办\n- [ ] 未办');
  const out = serialize(tree);
  assert.match(out, /<h1>标题<\/h1>/);
  assert.match(out, /<strong>加粗<\/strong>/);
  assert.match(out, /<em>斜体<\/em>/);
  assert.ok(collect(tree, 'code').some(node => node.textContent === 'code'));
  assert.match(out, /<ul><li>第一项<\/li><li>第二项<ul><li>嵌套<\/li><\/ul><\/li><\/ul>/);
  assert.match(out, /<ol><li>甲<\/li><li>乙<\/li><\/ol>/);
  assert.match(out, /<li\.task>/);
  const links = collect(tree, 'a');
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://example.com');
  assert.equal(links[0].target, '_blank');
  assert.equal(links[0].rel, 'noopener noreferrer');
});

test('markdown never parses raw HTML and rejects unsafe links', async () => {
  const { renderMarkdown } = await loadModule('../web/markdown.js');
  const tree = renderMarkdown('前文\n\n<img src=x onerror=alert(1)> and <script>alert(2)</script>\n\n[点击](javascript:alert(3)) 与 [正常](https://example.com)');
  const out = serialize(tree);
  assert.equal(collect(tree, 'img').length, 0);
  assert.equal(collect(tree, 'script').length, 0);
  assert.match(out, /<img src=x onerror=alert\(1\)>/); // stays literal text
  const links = collect(tree, 'a');
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://example.com');
  assert.equal(links[0].rel, 'noopener noreferrer');
});

test('markdown resolves local images and keeps unknown ones literal', async () => {
  const { renderMarkdown } = await loadModule('../web/markdown.js');
  const seen = [];
  const tree = renderMarkdown('![本地](shots/a.png) ![外部](https://cdn.example.com/b.png) ![禁止](file:///etc/passwd)', {
    resolveImage: src => { seen.push(src); return src.startsWith('https') ? src : src.startsWith('file:') ? undefined : '/raw?x'; },
  });
  assert.deepEqual(seen, ['shots/a.png', 'https://cdn.example.com/b.png', 'file:///etc/passwd']);
  assert.equal(collect(tree, 'img').length, 2);
  assert.match(serialize(tree), /!\[禁止\]\(file:\/\/\/etc\/passwd\)/);
});

test('markdown supports tables, quotes, fenced code and rules', async () => {
  const { renderMarkdown } = await loadModule('../web/markdown.js');
  let highlighted = '';
  const tree = renderMarkdown('| 左 | 右 |\n|---|---:|\n| a | 1 |\n\n> 引用一行\n\n```python\nprint(1)\n```\n\n---', {
    highlight: (code, source, lang) => { highlighted = `${lang}:${source}`; code.textContent = source; },
  });
  const out = serialize(tree);
  assert.match(out, /<thead><tr><th>左<\/th><th>右<\/th><\/tr><\/thead>/);
  assert.match(out, /<tbody><tr><td>a<\/td><td>1<\/td><\/tr><\/tbody>/);
  assert.match(out, /<blockquote><#fragment><p>引用一行/);
  assert.match(out, /<div\.md-code>print\(1\)<\/div>/);
  assert.ok(collect(tree, 'code').some(node => node.dataset.lang === 'python'));
  assert.equal(highlighted, 'python:print(1)');
  assert.match(out, /<hr><\/hr>/);
});

test('highlight maps filenames and tokens without altering text', async () => {
  const { highlightInto, languageForName } = await loadModule('../web/highlight.js');
  assert.equal(languageForName('app.ts'), 'clike');
  assert.equal(languageForName('notes.md'), 'markdown');
  assert.equal(languageForName('README'), null);
  assert.equal(languageForName('data.unknown'), null);
  const code = new FakeNode('code');
  const source = '// 注释\nconst answer = 42;\nlet text = "你好";';
  assert.equal(highlightInto(code, source, 'js'), true);
  const spans = [...code.children];
  assert.ok(spans.some(span => span.className === 'hl-com' && span.textContent === '// 注释'));
  assert.ok(spans.some(span => span.className === 'hl-kw' && span.textContent === 'const'));
  assert.ok(spans.some(span => span.className === 'hl-str' && span.textContent === '"你好"'));
  assert.equal(spans.map(span => span.textContent).join(''), source);
  const plain = new FakeNode('code');
  assert.equal(highlightInto(plain, 'just text', 'unknownlang'), false);
  assert.equal(plain.textContent, 'just text');
  assert.equal(plain.children.length, 0);
  const markup = new FakeNode('code');
  assert.equal(highlightInto(markup, '<div class="a">x</div>', 'html'), true);
  assert.ok([...markup.children].some(span => span.className === 'hl-tag' && span.textContent === 'div'));
  const diff = new FakeNode('code');
  assert.equal(highlightInto(diff, '+ added\n- removed', 'diff'), true);
  assert.ok([...diff.children].some(span => span.className === 'hl-add'));
  assert.ok([...diff.children].some(span => span.className === 'hl-del'));
});

test('quick search helpers parse modes, shorten paths and plan highlights', async () => {
  const { parseQuery, tildePath, matchRanges } = await loadModule('../web/quick-search.js', { t: key => key, formatBytes: () => '' });
  // Values cross the VM realm: compare by fields instead of prototypes.
  const asPlain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(asPlain(parseQuery('内容: 数据接口')), { content: true, query: '数据接口' });
  assert.deepEqual(asPlain(parseQuery('content:api')), { content: true, query: 'api' });
  assert.deepEqual(asPlain(parseQuery('内容：全角')), { content: true, query: '全角' });
  assert.deepEqual(asPlain(parseQuery('  hello  ')), { content: false, query: 'hello' });
  assert.equal(tildePath('/Users/me/a/b', '/Users/me'), '~/a/b');
  assert.equal(tildePath('/Users/me', '/Users/me'), '~');
  assert.equal(tildePath('/etc/hosts', '/Users/me'), '/etc/hosts');
  assert.deepEqual(asPlain(matchRanges('draft-file.txt', 'df')), [[0, 1], [3, 4]]);
  assert.deepEqual(asPlain(matchRanges('notes.txt', 'zz')), []);
  assert.deepEqual(asPlain(matchRanges('notes.txt', '')), []);
});
