/**
 * Bounded, dependency-free Markdown → DOM renderer for the built-in preview.
 *
 * Security model matches the page contract: every node is created with
 * `createElement` and filled with `textContent`, so no markup string is ever
 * parsed as HTML and no inline event can survive. Links are restricted to
 * http(s)/mailto; anything else degrades to plain text. The renderer covers the
 * GFM subset a file preview needs — headings, paragraphs, emphasis, code,
 * links, images, ordered/unordered/task lists, blockquotes, fenced code,
 * tables, rules — and nothing more, so output stays predictable.
 */

const MAX_SOURCE_CHARS = 300000;
const MAX_BLOCKS = 4000;
const MAX_TABLE_ROWS = 2000;
const MAX_INLINE_STEPS = 2000;
const MAX_LIST_DEPTH = 6;

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

function isBlank(line) {
  return !line.trim();
}

function headingLevel(line) {
  const match = /^(#{1,6})\s+(.*)$/.exec(line);
  return match ? { level: match[1].length, text: match[2] } : null;
}

function isRule(line) {
  return /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

function fenceOf(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) return trimmed.slice(0, 3);
  return null;
}

/** Split a table row into cells honouring escaped pipes. */
function tableCells(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let current = '';
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\') { current += char; escaped = true; continue; }
    if (char === '|') { cells.push(current.trim()); current = ''; continue; }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function isTableDivider(line) {
  return line.includes('|') && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function parseListMarker(line) {
  const match = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
  if (!match) return null;
  const indent = match[1].length;
  if (indent > 8) return null;
  return { indent, ordered: /\d/.test(match[2]), marker: match[2], text: match[3] };
}

function taskStatus(text) {
  const match = /^\[([ xX])\]\s+(.*)$/.exec(text);
  return match ? { done: match[1] !== ' ', rest: match[2] } : null;
}

/**
 * Render one inline run (text with `code`, **strong**, *em*, ~~del~~,
 * [link](href), ![img](src)) into the given parent. Link targets accept one
 * level of balanced parentheses so `f(a)` URLs stay whole.
 */
function renderInline(parent, text, options) {
  let remaining = String(text);
  const pattern = /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+)\*|_([^_\n]+)_|~~([\s\S]+?)~~|!?\[([^\]\n]*)\]\(((?:[^()\s]|\([^()]*\))+)(?:\s+"[^"]*")?\)/;
  let steps = 0;
  while (remaining && steps++ < MAX_INLINE_STEPS) {
    const match = pattern.exec(remaining);
    if (!match) break;
    if (match.index) parent.append(remaining.slice(0, match.index));
    remaining = remaining.slice(match.index + match[0].length);
    if (match[2] !== undefined) {
      const code = document.createElement('code');
      code.textContent = match[2];
      parent.append(code);
    } else if (match[3] !== undefined || match[4] !== undefined) {
      const strong = document.createElement('strong');
      renderInline(strong, match[3] ?? match[4], options);
      parent.append(strong);
    } else if (match[5] !== undefined || match[6] !== undefined) {
      const em = document.createElement('em');
      renderInline(em, match[5] ?? match[6], options);
      parent.append(em);
    } else if (match[7] !== undefined) {
      const del = document.createElement('del');
      del.textContent = match[7];
      parent.append(del);
    } else {
      const href = match[9], label = match[8] ?? '';
      if (match[0].startsWith('!')) {
        const resolved = options.resolveImage?.(href);
        if (resolved) {
          const image = document.createElement('img');
          image.alt = label; image.loading = 'lazy'; image.src = resolved;
          parent.append(image);
        } else {
          parent.append(`![${label}](${href})`);
        }
      } else if (SAFE_LINK.test(href)) {
        const link = document.createElement('a');
        link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer';
        renderInline(link, label, options);
        parent.append(link);
      } else {
        parent.append(label || href);
      }
    }
  }
  if (remaining) parent.append(remaining);
}

function renderParagraph(parent, lines, options) {
  const paragraph = document.createElement('p');
  lines.forEach((line, index) => {
    if (index) paragraph.append(document.createElement('br'));
    renderInline(paragraph, line, options);
  });
  parent.append(paragraph);
}

/**
 * Render consecutive list lines into one (possibly nested) list. Items are
 * created lazily (no empty first bullet) and scanning stops at a shallower
 * level or a marker-type change so the caller can start a fresh list, which
 * matches how CommonMark closes and reopens lists.
 */
function renderList(parent, lines, start, options) {
  const first = parseListMarker(lines[start]);
  const root = document.createElement(first.ordered ? 'ol' : 'ul');
  if (first.ordered && !/^1[.)]$/.test(first.marker)) root.start = Number.parseInt(first.marker, 10) || 1;
  const lists = [root], items = [];
  let depth = 0;
  const openItem = () => {
    if (!items[depth] || items[depth].childNodes.length) {
      items[depth] = document.createElement('li');
      lists[depth].append(items[depth]);
    }
    return items[depth];
  };
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (isBlank(line)) { index++; continue; }
    const marker = parseListMarker(line);
    if (!marker) {
      // Only indented lines continue the current item; an unindented block
      // (fence, table, new paragraph) closes the list so the main loop can
      // parse it as its own block.
      if (!/^\s/.test(line) || !items[depth]) break;
      const target = items[depth];
      if (target.childNodes.length) target.append(document.createElement('br'));
      renderInline(target, line.trim(), options);
      index++;
      continue;
    }
    const want = Math.min(Math.floor(marker.indent / 2), MAX_LIST_DEPTH - 1);
    if (want < depth || (want === depth && lists[depth] && Boolean(lists[depth].children.length) && marker.ordered !== (lists[depth].tagName === 'OL'))) {
      // A shallower level or a different marker type closes this list; the
      // caller re-enters and starts a new one.
      break;
    }
    if (want > depth) {
      while (want > depth) {
        const nested = document.createElement(marker.ordered ? 'ol' : 'ul');
        lists[depth + 1] = nested;
        // Nest under the item that is already open at this level.
        (items[depth] ?? root).append(nested);
        depth++;
        items[depth] = document.createElement('li');
        nested.append(items[depth]);
      }
    } else {
      openItem();
    }
    const target = items[depth];
    const task = taskStatus(marker.text);
    if (task) {
      target.classList.add('task');
      const box = document.createElement('input');
      box.type = 'checkbox'; box.checked = task.done; box.disabled = true;
      target.append(box, ' ');
      renderInline(target, task.rest, options);
    } else {
      renderInline(target, marker.text, options);
    }
    index++;
  }
  parent.append(root);
  return index - start;
}

function renderFencedCode(parent, info, body, options) {
  const wrapper = document.createElement('div');
  wrapper.className = 'md-code';
  const code = document.createElement('code');
  const language = (info ?? '').trim().split(/\s+/)[0].toLowerCase();
  if (language) code.dataset.lang = language;
  if (options.highlight && language) options.highlight(code, body, language);
  else code.textContent = body;
  wrapper.append(code);
  parent.append(wrapper);
}

function renderTable(parent, header, divider, rows, options) {
  const columns = Math.max(1, tableCells(header).length);
  const alignments = tableCells(divider).map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : null);
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const cell of tableCells(header).slice(0, columns)) {
    const th = document.createElement('th');
    renderInline(th, cell, options);
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);
  const tbody = document.createElement('tbody');
  for (const row of rows.slice(0, MAX_TABLE_ROWS)) {
    const tr = document.createElement('tr');
    tableCells(row).slice(0, columns).forEach((cell, index) => {
      const td = document.createElement('td');
      if (alignments[index]) td.style.textAlign = alignments[index];
      renderInline(td, cell, options);
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(tbody);
  parent.append(table);
}

/**
 * Render Markdown into a DocumentFragment. `options.resolveImage(src)` maps a
 * local/relative image target to a same-origin URL (or returns falsy to keep
 * the literal text); `options.highlight(codeEl, source, lang)` fills a code
 * element for fenced blocks.
 */
export function renderMarkdown(source, options = {}) {
  const fragment = document.createDocumentFragment();
  const lines = String(source ?? '').slice(0, MAX_SOURCE_CHARS).split('\n');
  let index = 0;
  let blocks = 0;
  while (index < lines.length && blocks++ < MAX_BLOCKS) {
    const line = lines[index];
    if (isBlank(line)) { index++; continue; }
    const heading = headingLevel(line);
    if (heading) {
      const node = document.createElement(`h${heading.level}`);
      renderInline(node, heading.text, options);
      fragment.append(node);
      index++;
      continue;
    }
    if (isRule(line)) { fragment.append(document.createElement('hr')); index++; continue; }
    const fence = fenceOf(line);
    if (fence) {
      const info = line.trim().slice(3);
      const body = [];
      index++;
      while (index < lines.length && !lines[index].trim().startsWith(fence)) { body.push(lines[index]); index++; }
      index++; // Skip the closing fence (or EOF).
      renderFencedCode(fragment, info, body.join('\n'), options);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = document.createElement('blockquote');
      const quoted = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/, ''));
        index++;
      }
      quote.append(renderMarkdown(quoted.join('\n'), options));
      fragment.append(quote);
      continue;
    }
    if (parseListMarker(line)) {
      index += renderList(fragment, lines, index, options);
      continue;
    }
    if (line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const divider = lines[index + 1];
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && !isBlank(lines[index])) { rows.push(lines[index]); index++; }
      renderTable(fragment, line, divider, rows, options);
      continue;
    }
    const paragraph = [];
    while (index < lines.length && !isBlank(lines[index]) && !headingLevel(lines[index]) && !isRule(lines[index]) && !fenceOf(lines[index]) && !/^\s*>/.test(lines[index]) && !parseListMarker(lines[index])) {
      paragraph.push(lines[index]);
      index++;
    }
    if (paragraph.length) renderParagraph(fragment, paragraph, options);
    else index++; // Safety against parser stalls.
  }
  return fragment;
}
