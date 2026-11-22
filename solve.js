// sitegen-fast: a faster drop-in replacement for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build returns
// for the same input, byte for byte. The implementation is written from the
// dialect spec (the reference README) and the reference's observable behaviour;
// it is not a copy of the reference code. Speed comes from:
//   - a single-pass Markdown renderer that writes into arrays and joins once,
//     with chunked HTML escaping instead of one regex replace per character;
//   - templates compiled once per case into a node tree and rendered into an
//     output array (no string concatenation in hot loops);
//   - per-case memoisation of slugify/longDate results (nothing is cached
//     across cases: every cache lives in the per-run state object);
//   - hand-rolled line/class checks in place of per-line regexes;
//   - word counting and link resolution by direct character tests.
//
// No cross-case state: run() builds a fresh state object per call.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ------------------------------------------------------------------ text

/** The HTML escape table. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_ALL = /[&<>"']/g;

/** `text` with & < > " and ' escaped. Fast path returns the input untouched. */
function escapeHtml(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_ALL, (c) => ESCAPES[c]);
}

/** Whether char code `c` is JavaScript whitespace (the \s set). */
function isWsCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 160 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** The slug of `text`, uncached. Pure-ASCII input skips NFKD and mark stripping. */
function slugifyRaw(text) {
  let plain = text;
  if (/[^\x00-\x7F]/.test(text)) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** The slug of `text`, memoised inside this run's state. */
function slugify(S, text) {
  const hit = S.slugCache.get(text);
  if (hit !== undefined) return hit;
  const s = slugifyRaw(text);
  S.slugCache.set(text, s);
  return s;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out;
  while (taken.has((out = `${slug}-${n}`))) n++;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, memoised inside this run's state. */
function longDate(S, date) {
  let v = S.dateCache.get(date);
  if (v === undefined) {
    const [y, m, d] = date.split('-');
    v = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
    S.dateCache.set(date, v);
  }
  return v;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 160 || c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ------------------------------------------------------------------ front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or a bare value. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Only the front-matter lines
 * are materialised; the body is one slice of the input.
 */
function parseFrontMatter(text) {
  const n = text.length;
  let nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  // Scan the lines after the opener for the closing '---', collecting them.
  let pos = nl === -1 ? n : nl + 1;
  const fmLines = [];
  let closeEnd = -1;
  let lineNo = 1; // 0-based index of the line starting at pos
  while (pos < n) {
    const end = text.indexOf('\n', pos);
    const line = end === -1 ? text.slice(pos) : text.slice(pos, end);
    if (line === '---') {
      closeEnd = end === -1 ? n : end + 1;
      break;
    }
    fmLines.push(line);
    lineNo++;
    pos = end === -1 ? n : end + 1;
  }
  if (closeEnd === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let k = 0; k < fmLines.length; k++) {
    const line = fmLines[k];
    const i = k + 1; // 0-based line index, as the reference counts it
    if (FM_BLANK.test(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ------------------------------------------------------------------ Markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-open line's language, or null when the line is not a fence open. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const langEnd = i;
  while (i < n && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i === n ? line.slice(3, langEnd) : null;
}

/** Whether `line` closes a fence: three backticks, spaces or tabs after them. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h < 1 || h > 6) return null;
  let i = h;
  if (i >= line.length || (line.charCodeAt(i) !== 32 && line.charCodeAt(i) !== 9)) return null;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  let b = line.length;
  while (b > i && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === i) return null;
  return { depth: h, text: line.slice(i, b) };
}

/** Whether `line` is a thematic break: `---` or `***`, spaces or tabs after. */
function isHr(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let i = 3; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch !== 32 && ch !== 9) return false;
  }
  return true;
}

/** A bullet list line's item text, or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c !== 45 && c !== 42) || line.charCodeAt(1) !== 32) return null;
  return line.slice(2);
}

/** An ordered list line's number and item text, or null. */
function orderedOf(line) {
  let i = 0;
  const n = line.length;
  while (i < n && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i < 1 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < line.length && !isWsCode(line.charCodeAt(i));
}

/** Whether the character at `j` is escaped: the run of backslashes just before it has odd length. */
function isEscaped(s, j) {
  let k = j - 1;
  let n = 0;
  while (k >= 0 && s[k] === '\\') {
    n++;
    k--;
  }
  return (n % 2) === 1;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = from;
  for (;;) {
    j = s.indexOf(what, j);
    if (j === -1) return -1;
    if (isEscaped(s, j)) {
      j += 1;
      continue;
    }
    return j;
  }
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = from;
  for (;;) {
    j = s.indexOf('*', j);
    if (j === -1) return -1;
    if (isEscaped(s, j)) {
      j += 1;
      continue;
    }
    if (s[j + 1] === '*') {
      j += 2;
      continue;
    }
    return j;
  }
}

/**
 * `s` rendered inline into `out`; `env.link(target)` is a link's href. A regex
 * jumps from one inline construct to the next, so plain runs are sliced and
 * escaped whole instead of walked character by character. The regex is shared
 * and its lastIndex saved and restored around the recursive calls.
 */
const INLINE_RE = /[\\`*[]/g;

function inlineInto(s, env, out) {
  const saved = INLINE_RE.lastIndex;
  INLINE_RE.lastIndex = 0;
  const re = INLINE_RE;
  let plain = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const i = m.index;
    const c = m[0];
    if (c === '\\') {
      if (i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
        if (i > plain) out.push(escapeHtml(s.slice(plain, i)));
        out.push(escapeHtml(s[i + 1]));
        re.lastIndex = i + 2;
        plain = i + 2;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > plain) out.push(escapeHtml(s.slice(plain, i)));
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        re.lastIndex = j + 1;
        plain = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > plain) out.push(escapeHtml(s.slice(plain, i)));
          out.push('<strong>');
          inlineInto(s.slice(i + 2, j), env, out);
          out.push('</strong>');
          re.lastIndex = j + 2;
          plain = j + 2;
        } else {
          re.lastIndex = i + 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > plain) out.push(escapeHtml(s.slice(plain, i)));
        out.push('<em>');
        inlineInto(s.slice(i + 1, j), env, out);
        out.push('</em>');
        re.lastIndex = j + 1;
        plain = j + 1;
      }
      continue;
    }
    const k = findUnescaped(s, ']', i + 1);
    const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !/\s/.test(target)) {
      if (i > plain) out.push(escapeHtml(s.slice(plain, i)));
      out.push('<a href="', escapeHtml(env.link(target)), '">');
      inlineInto(s.slice(i + 1, k), env, out);
      out.push('</a>');
      re.lastIndex = mm + 1;
      plain = mm + 1;
    }
  }
  if (s.length > plain) out.push(escapeHtml(s.slice(plain)));
  INLINE_RE.lastIndex = saved;
}

/**
 * `src` rendered in one pass: its HTML, its table of contents (level 2 and 3
 * headings) and its excerpt (the first paragraph's inline HTML, or "").
 * Lines are walked by index (no per-line objects); the block dispatch reads
 * each line's first character, and a paragraph's end test does the same. All
 * output goes into one parts array, joined once at the end.
 */
function renderMarkdown(S, src, env) {
  const n = src.length;
  const parts = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let pos = 0;
  while (pos < n) {
    const e = src.indexOf('\n', pos);
    const lineEnd = e === -1 ? n : e;
    const line = src.slice(pos, lineEnd);
    const next = e === -1 ? n : e + 1;
    const c0 = line.charCodeAt(0);
    if (lineEnd === pos) {
      pos = next;
      continue;
    }
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        pos = next;
        continue;
      }
      // An indented line at a block start is paragraph text.
    } else if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        parts.push('<pre><code', lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`, '>');
        pos = next;
        let closed = false;
        while (pos < n) {
          const e2 = src.indexOf('\n', pos);
          const le2 = e2 === -1 ? n : e2;
          const l2 = src.slice(pos, le2);
          const nx2 = e2 === -1 ? n : e2 + 1;
          if (isFenceClose(l2)) {
            pos = nx2;
            closed = true;
            break;
          }
          parts.push(escapeHtml(l2), '\n');
          pos = nx2;
        }
        // An unclosed fence also swallows the empty line a trailing "\n" leaves
        // behind (the reference lexes split('\n') lines, so that line exists).
        if (!closed && n > 0 && src.charCodeAt(n - 1) === 10) parts.push('\n');
        parts.push('</code></pre>', '\n');
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(S, heading.text), ids);
        const hp = [];
        inlineInto(heading.text, env, hp);
        const html = hp.join('');
        parts.push(`<h${heading.depth} id="${id}">`, ...hp, `</h${heading.depth}>`, '\n');
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        pos = next;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        parts.push('<hr>', '\n');
        pos = next;
        continue;
      }
      const bullet = bulletOf(line);
      if (bullet !== null) {
        const items = [];
        while (pos < n) {
          const e2 = src.indexOf('\n', pos);
          const le2 = e2 === -1 ? n : e2;
          const l2 = src.slice(pos, le2);
          const nx2 = e2 === -1 ? n : e2 + 1;
          const m = bulletOf(l2);
          if (m !== null) {
            items.push([trimLine(m)]);
            pos = nx2;
            continue;
          }
          if (isContinued(l2)) {
            items[items.length - 1].push(trimLine(l2));
            pos = nx2;
            continue;
          }
          break;
        }
        parts.push('<ul>', '\n');
        for (const item of items) {
          parts.push('<li>');
          inlineInto(item.join('\n'), env, parts);
          parts.push('</li>', '\n');
        }
        parts.push('</ul>', '\n');
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (pos < n) {
        const e2 = src.indexOf('\n', pos);
        const le2 = e2 === -1 ? n : e2;
        const l2 = src.slice(pos, le2);
        const nx2 = e2 === -1 ? n : e2 + 1;
        if (l2.charCodeAt(0) !== 62) break;
        let t = l2.slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        t = trimLine(t);
        if (t !== '') body.push(t);
        pos = nx2;
      }
      if (body.length === 0) {
        parts.push('<blockquote>\n</blockquote>', '\n');
      } else {
        parts.push('<blockquote>\n<p>');
        inlineInto(body.join('\n'), env, parts);
        parts.push('</p>\n</blockquote>', '\n');
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = orderedOf(line);
      if (ordered !== null) {
        const start = ordered.num;
        const items = [];
        while (pos < n) {
          const e2 = src.indexOf('\n', pos);
          const le2 = e2 === -1 ? n : e2;
          const l2 = src.slice(pos, le2);
          const nx2 = e2 === -1 ? n : e2 + 1;
          const m = orderedOf(l2);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            pos = nx2;
            continue;
          }
          if (isContinued(l2)) {
            items[items.length - 1].push(trimLine(l2));
            pos = nx2;
            continue;
          }
          break;
        }
        parts.push(start !== 1 ? `<ol start="${start}">` : '<ol>', '\n');
        for (const item of items) {
          parts.push('<li>');
          inlineInto(item.join('\n'), env, parts);
          parts.push('</li>', '\n');
        }
        parts.push('</ol>', '\n');
        continue;
      }
    }
    // A paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break.
    const body = [trimLine(line)];
    pos = next;
    while (pos < n) {
      const e2 = src.indexOf('\n', pos);
      const le2 = e2 === -1 ? n : e2;
      const l2 = src.slice(pos, le2);
      const nx2 = e2 === -1 ? n : e2 + 1;
      if (le2 === pos) break;
      const d0 = l2.charCodeAt(0);
      let ends = false;
      if (d0 === 32 || d0 === 9) ends = isBlank(l2);
      else if (d0 === 96) ends = fenceLang(l2) !== null;
      else if (d0 === 35) ends = headingOf(l2) !== null;
      else if (d0 === 45 || d0 === 42) ends = isHr(l2);
      if (ends) break;
      body.push(trimLine(l2));
      pos = nx2;
    }
    if (excerpt === null) {
      const pp = [];
      inlineInto(body.join('\n'), env, pp);
      excerpt = pp.join('');
      parts.push('<p>', ...pp, '</p>', '\n');
    } else {
      parts.push('<p>');
      inlineInto(body.join('\n'), env, parts);
      parts.push('</p>', '\n');
    }
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const TMPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TMPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TMPL_IF = /^if (not )?(\S+)$/;
const TMPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!TMPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TMPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TMPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TMPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * The value at `path` in the scope chain: its first name from the nearest scope
 * holding it, then own properties. The first name is read by direct access
 * (a scope's own values are never undefined, and an inherited Object.prototype
 * member is a function, which reads as "" exactly as undefined does); only
 * the undefined case falls back to hasOwn, so the walk stays exact.
 */
function lookup(scope, path) {
  let s = scope;
  while (s !== null) {
    const v0 = s.vars[path[0]];
    if (v0 !== undefined) {
      let v = v0;
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
    if (Object.hasOwn(s.vars, path[0])) return undefined;
    s = s.parent;
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** `nodes` rendered into `out` in `scope` ({ vars, parent }) at include `depth`. */
function renderNodes(nodes, scope, S, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        const v = lookup(scope, n.path);
        if (typeof v === 'string') out.push(escapeHtml(v));
        else if (typeof v === 'number') out.push(String(v));
        else if (typeof v === 'boolean') out.push(v ? 'true' : 'false');
        else if (Array.isArray(v)) out.push(escapeHtml(textOf(v)));
        break;
      }
      case 'raw': {
        const v = lookup(scope, n.path);
        if (typeof v === 'string') out.push(v);
        else if (typeof v === 'number') out.push(String(v));
        else if (typeof v === 'boolean') out.push(v ? 'true' : 'false');
        else if (Array.isArray(v)) out.push(textOf(v));
        break;
      }
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, S, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, S, depth, out);
        }
        break;
      }
      case 'include': {
        const t = S.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, S, depth + 1, out);
        break;
      }
    }
  }
}

// ------------------------------------------------------------------ the build

/** A page's link record as templates read it. */
const linkOf = (S, s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(S, s.data.date) });

/** A post's card, as lists show it (computed once per source in this run). */
function cardOf(S, s) {
  let c = s._card;
  if (c === undefined) {
    c = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(S, s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s._card = c;
  }
  return c;
}

/** A page as its layout reads it. */
function pageOf(S, s) {
  return {
    ...cardOf(S, s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(S, s.newer ?? null),
    older: linkOf(S, s.older ?? null),
    is_post: s.post,
  };
}

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  let i = 1;
  while (i < target.length) {
    const c = target.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) i++;
    else break;
  }
  return target.charCodeAt(i) === 58;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const S = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates: new Map(),
    report: [],
    slugCache: new Map(),
    dateCache: new Map(),
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // Templates, parsed in code-unit order of name; one that does not parse is
  // reported and left out.
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      S.templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      S.report.push(err.message);
    }
  }

  // Sources, in code-unit order of path; line ends made "\n" for .md sources.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) S.sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else S.statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in the order the checks run.
  const kept = [];
  for (const s of S.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      S.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      S.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      S.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!S.templates.has(layout)) {
      S.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      S.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  S.sources = kept;

  // Permalinks: each page's slug, made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let t = taken.get(dir);
    if (t === undefined) {
      t = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, t);
    }
    return t;
  };
  for (const s of S.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(S, s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${S.base}/${s.outDir}/`;
    S.bySource.set(s.path, s);
  }

  // Markdown: each body's HTML, its links resolved.
  const staticPaths = new Set(S.statics.map((f) => f.path));
  for (const s of S.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null) {
          const pg = S.bySource.get(path);
          if (pg !== undefined) return `${pg.url}${frag}`;
          if (staticPaths.has(path)) return `${S.base}/${path}${frag}`;
        }
        S.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(S, s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest first, then by slug; newer/older neighbours.
  const posts = S.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  S.posts = posts;
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (const name of tags) {
      const slug = slugify(S, name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of S.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(S, name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${S.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of S.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(S, name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  S.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts: every page through its layout, the index and tag pages.
  S.cards = new Map(S.posts.map((p) => [p, cardOf(S, p)]));
  const site = { title: S.input.site.title, base_url: S.base };
  const allTags = S.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = S.posts.slice(0, S.input.site.recent).map((p) => S.cards.get(p));
  const render = (name, vars) => {
    const nodes = S.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, S, 0, out);
    return out.join('');
  };
  for (const s of S.sources) S.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(S, s) });
  const per = S.input.site.per_page;
  const pages = Math.max(1, Math.ceil(S.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${S.base}/` : `${S.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: S.posts.slice((k - 1) * per, k * per).map((p) => S.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) S.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of S.tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => S.cards.get(p)) } });
    if (html !== null) S.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) S.output['tags/index.html'] = tagsHtml;
  for (const f of S.statics) {
    if (Object.hasOwn(S.output, f.path)) S.report.push(`shadowed ${f.path}: a built page has its path`);
    else S.output[f.path] = f.content;
  }

  // The report: every line reported above and each broken link, sorted, then the counts.
  const lines = [...S.report, ...S.broken].sort(byCodeUnits);
  const pageCount = S.sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${S.posts.length} posts, ${S.tags.length} tags and ${S.statics.length} static files`);
  S.output['build-report.txt'] = `${lines.join('\n')}\n`;
  return S.output;
}
