/**
 * Lightweight, bounded syntax highlighting for the built-in preview.
 *
 * Zero dependency and DOM-only: the tokenizer emits plain-text spans, so no
 * HTML string is ever parsed and nothing can inject markup. It covers the
 * common families well enough to read a file — not a full grammar — and
 * silently falls back to plain text for unknown languages or oversized input.
 */

const MAX_HIGHLIGHT_CHARS = 200000;
const MAX_TOKENS = 20000;

export const LANGUAGE_BY_EXT = new Map([
  ['js', 'clike'], ['mjs', 'clike'], ['cjs', 'clike'], ['jsx', 'clike'],
  ['ts', 'clike'], ['tsx', 'clike'], ['java', 'clike'], ['c', 'clike'],
  ['h', 'clike'], ['cpp', 'clike'], ['hpp', 'clike'], ['cc', 'clike'],
  ['cs', 'clike'], ['go', 'clike'], ['rs', 'clike'], ['swift', 'clike'],
  ['kt', 'clike'], ['kts', 'clike'], ['php', 'clike'], ['scala', 'clike'],
  ['dart', 'clike'], ['lua', 'clike'], ['groovy', 'clike'],
  ['py', 'python'], ['pyw', 'python'], ['rb', 'ruby'],
  ['sh', 'shell'], ['bash', 'shell'], ['zsh', 'shell'], ['fish', 'shell'], ['ps1', 'shell'],
  ['css', 'css'], ['scss', 'css'], ['sass', 'css'], ['less', 'css'],
  ['html', 'markup'], ['htm', 'markup'], ['xml', 'markup'], ['svg', 'markup'], ['vue', 'markup'], ['svelte', 'markup'], ['astro', 'markup'],
  ['json', 'json'], ['jsonc', 'json'], ['json5', 'json'],
  ['yml', 'yaml'], ['yaml', 'yaml'], ['toml', 'toml'], ['ini', 'toml'], ['cfg', 'toml'], ['conf', 'toml'],
  ['sql', 'sql'], ['graphql', 'sql'], ['gql', 'sql'],
  ['diff', 'diff'], ['patch', 'diff'],
  ['md', 'markdown'], ['markdown', 'markdown'], ['mdx', 'markdown'],
]);

const KEYWORDS = {
  clike: 'as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return set static super switch this throw true try type typeof var void while with yield'.split(' '),
  python: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case'.split(' '),
  ruby: 'BEGIN END alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield'.split(' '),
  shell: 'break case continue do done elif else esac exit export fi for function if in return set shift then until while echo cd local readonly'.split(' '),
  css: '',
  markup: '',
  json: 'true false null'.split(' '),
  yaml: 'true false null yes no on off'.split(' '),
  toml: 'true false'.split(' '),
  sql: 'select from where insert into values update delete create table drop alter add join left right inner outer on group by order asc desc limit offset having distinct as and or not null primary key foreign references index view union all exists between like in is'.split(' '),
  diff: '', markdown: '',
};

const FAMILIES = {
  clike: { line: ['//'], block: [['/*', '*/']], strings: [`'`, '"', '`'] },
  python: { line: ['#'], block: [["'''", "'''"], ['"""', '"""']], strings: ["'", '"'] },
  ruby: { line: ['#'], block: [['=begin', '=end']], strings: ["'", '"', '`'] },
  shell: { line: ['#'], block: [], strings: ["'", '"'] },
  css: { line: [], block: [['/*', '*/']], strings: ["'", '"'] },
  json: { line: ['//'], block: [['/*', '*/']], strings: ['"'] },
  yaml: { line: ['#'], block: [], strings: ["'", '"'] },
  toml: { line: ['#'], block: [], strings: ["'", '"'] },
  sql: { line: ['--'], block: [['/*', '*/']], strings: ["'"] },
  diff: { line: [], block: [], strings: [] },
  markdown: { line: [], block: [], strings: [] },
  markup: { line: [], block: [['<!--', '-->']], strings: [] },
};

/** Build one alternation that matches any interesting token at position 0. */
function scanner(family, keywords) {
  const rules = [];
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [open, close] of family.block) rules.push({ kind: 'com', re: new RegExp(`${escape(open)}[\\s\\S]*?(?:${escape(close)}|$)`) });
  for (const open of family.line) rules.push({ kind: 'com', re: new RegExp(`${escape(open)}[^\\n]*`) });
  for (const quote of family.strings) rules.push({ kind: 'str', re: new RegExp(`${escape(quote)}(?:\\\\.|[^\\\\\\n${escape(quote)}])*${escape(quote)}?`) });
  if (keywords?.length) rules.push({ kind: 'kw', re: new RegExp(`(?:${keywords.map(escape).join('|')})\\b`) });
  rules.push({ kind: 'num', re: /0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/ });
  rules.push({ kind: 'fn', re: /[A-Za-z_$][\w$]*(?=\s*\()/ });
  rules.push({ kind: 'var', re: /[$@]\w+/ });
  rules.push({ kind: 'punc', re: /[{}[\]();:,.<>+\-*/%=!&|?^~]+/ });
  const combined = new RegExp(rules.map(rule => `(${rule.re.source})`).join('|'), 'g');
  return { combined, order: rules.map(rule => rule.kind) };
}

function emit(parent, text, kind) {
  if (!text) return;
  if (kind) {
    const span = document.createElement('span');
    span.className = `hl-${kind}`;
    span.textContent = text;
    parent.append(span);
  } else {
    parent.append(text);
  }
}

function runScanner(parent, source, family, keywords) {
  const { combined, order } = scanner(family, keywords);
  combined.lastIndex = 0;
  let last = 0, tokens = 0, match;
  while ((match = combined.exec(source)) && tokens++ < MAX_TOKENS) {
    if (match.index > last) emit(parent, source.slice(last, match.index));
    const group = match.slice(1).findIndex(value => value !== undefined);
    emit(parent, match[0], order[group]);
    last = match.index + match[0].length;
    if (match[0].length === 0) combined.lastIndex++;
  }
  if (last < source.length) emit(parent, source.slice(last));
}

function runMarkup(parent, source) {
  const pattern = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<!?\/?[A-Za-z][\w:-]*(?:"[^"]*"|'[^']*'|[^>"'])*>?/g;
  let last = 0, tokens = 0, match;
  while ((match = pattern.exec(source)) && tokens++ < MAX_TOKENS) {
    if (match.index > last) emit(parent, source.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('<![')) emit(parent, token, 'com');
    else if (!token.startsWith('<')) emit(parent, token);
    else {
      const parts = /^(<\/?)([A-Za-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(>?)$/.exec(token);
      if (!parts) emit(parent, token);
      else {
        emit(parent, parts[1], 'punc');
        emit(parent, parts[2], 'tag');
        const attrs = parts[3];
        let rest = attrs, guard = 0;
        const attrPattern = /([\w:-]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)?\s*|([\w:-]+)\s*/g;
        while (rest && guard++ < 500) {
          const attr = attrPattern.exec(rest);
          if (!attr) { emit(parent, rest, 'attr'); break; }
          emit(parent, rest.slice(0, attr.index), 'attr');
          if (attr[1]) {
            emit(parent, attr[1], 'attr');
            if (attr[2]) emit(parent, attr[2], 'punc');
            if (attr[3]) emit(parent, attr[3], 'str');
          } else if (attr[4]) emit(parent, attr[4], 'attr');
          rest = rest.slice(attr.index + attr[0].length);
        }
        emit(parent, parts[4], 'punc');
      }
    }
    last = match.index + token.length;
  }
  if (last < source.length) emit(parent, source.slice(last));
}

function runDiff(parent, source) {
  for (const line of source.split('\n')) {
    const kind = line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') ? 'meta'
      : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : undefined;
    emit(parent, line, kind);
    emit(parent, '\n');
  }
}

function runMarkdown(parent, source) {
  const pattern = /^#{1,6} .*|^```[\s\S]*?(?:```|$)|^\s*[-*+] \[[ xX]\] .*$|\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]*\]\([^)\n]*\)/gm;
  let last = 0, tokens = 0, match;
  while ((match = pattern.exec(source)) && tokens++ < MAX_TOKENS) {
    if (match.index > last) emit(parent, source.slice(last, match.index));
    const token = match[0];
    const kind = token.startsWith('#') ? 'kw' : token.startsWith('```') ? 'str' : token.startsWith('**') || token.startsWith('`') ? 'fn' : 'attr';
    emit(parent, token, kind);
    last = match.index + token.length;
  }
  if (last < source.length) emit(parent, source.slice(last));
}

/**
 * Fill `code` with highlighted spans. Languages may be given as an extension
 * ("js") or a family ("clike"); unknown ones render as plain text.
 */
export function highlightInto(code, source, language) {
  const normalized = LANGUAGE_BY_EXT.get(String(language ?? '').toLowerCase()) ?? language;
  const text = String(source ?? '').slice(0, MAX_HIGHLIGHT_CHARS);
  const family = FAMILIES[normalized];
  if (!family) { code.textContent = text; return false; }
  if (normalized === 'markup') { runMarkup(code, text); return true; }
  if (normalized === 'diff') { runDiff(code, text); return true; }
  if (normalized === 'markdown') { runMarkdown(code, text); return true; }
  runScanner(code, text, family, KEYWORDS[normalized]);
  return true;
}

/** Resolve a filename to a highlight family, or null. */
export function languageForName(name) {
  const ext = String(name ?? '').split('.').pop().toLowerCase();
  return ext && name?.includes('.') ? LANGUAGE_BY_EXT.get(ext) ?? null : null;
}
