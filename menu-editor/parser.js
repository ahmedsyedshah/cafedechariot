/**
 * parser.js
 * -----------------------------------------------------------------------
 * Reads a Cafe De Chariot style menu-modal.html file and extracts every
 * editable menu item from it, WITHOUT building a DOM and WITHOUT touching
 * anything else in the file. Every item keeps a pointer (start/end offset)
 * back into the original raw text so that edits can be applied as small,
 * surgical string replacements. This is what lets us "preserve all styling
 * and structure" - we never regenerate the HTML from scratch, we only
 * splice the exact bytes that changed.
 *
 * There are two families of items in this kind of file:
 *
 *   1. INLINE items - written directly in the HTML as
 *        <div class="deal-card" onclick="showPreview('Name','Price','Img','Desc',this)">
 *      or
 *        <li onclick="showPreview('Name','Price','Img','Desc',this)">...</li>
 *
 *   2. DATA items - plain JS objects inside `const someList = [ {...}, ... ];`
 *      arrays near the bottom of the file, rendered at runtime by
 *      buildList()/buildPizzaRows() helper functions.
 *
 * Both kinds are normalized into the same shape so the UI doesn't need to
 * care which one it's looking at:
 *
 *   {
 *     id, kind: 'inline' | 'data',
 *     name, price, desc, note, img,
 *     section, page,
 *     sizes: { p7, p10, p13 } | null   // only for pizza rows
 *   }
 */

'use strict';

const SECTION_RE = /<div class="sec-(?:title|sub)(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/div>/g;
const PAGE_RE = /<div class="menu-page[^"]*" id="page-(\d+)"/g;
const PAGE_TITLE_RE = /<button class="menu-tab[^"]*" onclick="switchPage\(\d+,this\)">([\s\S]*?)<\/button>/g;

const INLINE_ONCLICK_RE =
  /onclick="showPreview\('((?:[^'\\]|\\.)*)','((?:[^'\\]|\\.)*)','((?:[^'\\]|\\.)*)','((?:[^'\\]|\\.)*)',this\)"/g;

// Data arrays we know how to read/write. `shape` tells us which fields to expect.
const DATA_ARRAYS = [
  { name: 'specialPizzas', section: 'Special Pizza', shape: 'pizza' },
  { name: 'tradPizzas', section: 'Traditional Pizza', shape: 'pizza' },
  { name: 'crustPizzas', section: 'Crust Pizza', shape: 'pizza' },
  { name: 'wraps', section: 'Wraps', shape: 'simple' },
  { name: 'grillBurgers', section: 'Grill Burgers', shape: 'simple' },
  { name: 'burgers', section: 'Burgers', shape: 'simple' },
  { name: 'rolls', section: 'Rolls', shape: 'simple' },
  { name: 'sandwiches', section: 'Sandwiches', shape: 'simple' },
  { name: 'nuggets', section: 'Nuggets', shape: 'simple' },
  { name: 'wings', section: 'Wings', shape: 'simple' },
  { name: 'sidelines', section: 'Sidelines', shape: 'simple' },
  { name: 'addons', section: 'Add-Ons', shape: 'simple' },
];

function stripTags(s) {
  return s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim();
}

function unescapeJsString(s) {
  return s.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function escapeJsSingleQuoted(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escapeJsDoubleQuoted(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Find markers (section titles, page boundaries) with their offsets, sorted. */
function findMarkers(raw) {
  const markers = [];

  let m;
  SECTION_RE.lastIndex = 0;
  while ((m = SECTION_RE.exec(raw))) {
    markers.push({ offset: m.index, type: 'section', text: stripTags(m[1]) });
  }

  PAGE_RE.lastIndex = 0;
  while ((m = PAGE_RE.exec(raw))) {
    markers.push({ offset: m.index, type: 'page', page: parseInt(m[1], 10) });
  }

  markers.sort((a, b) => a.offset - b.offset);
  return markers;
}

function pageTitles(raw) {
  const titles = [];
  let m;
  PAGE_TITLE_RE.lastIndex = 0;
  while ((m = PAGE_TITLE_RE.exec(raw))) {
    titles.push(stripTags(m[1]));
  }
  return titles;
}

function markerContextAt(markers, offset) {
  let section = 'General';
  let page = 0;
  for (const mk of markers) {
    if (mk.offset > offset) break;
    if (mk.type === 'section') section = mk.text;
    if (mk.type === 'page') {
      page = mk.page;
      section = 'Featured'; // reset - real section title (if any) will override below
    }
  }
  return { section, page };
}

/**
 * Given the offset of the `onclick="showPreview(...)"` attribute, walk
 * backward to find the start of its owning opening tag (`<div`, `<li`, ...),
 * then walk forward counting nested same-name tags to find the matching
 * closing tag. Returns {start, end, tagName} spanning the whole element.
 */
function findOwningElement(raw, onclickOffset) {
  const ltBefore = raw.lastIndexOf('<', onclickOffset);
  if (ltBefore === -1) return null;
  const tagMatch = /^<([a-zA-Z0-9]+)/.exec(raw.slice(ltBefore));
  if (!tagMatch) return null;
  const tagName = tagMatch[1];

  const openTagEnd = raw.indexOf('>', onclickOffset);
  if (openTagEnd === -1) return null;

  const openRe = new RegExp(`<${tagName}(\\s|>)`, 'g');
  const closeRe = new RegExp(`</${tagName}>`, 'g');

  let depth = 1;
  let cursor = openTagEnd + 1;
  while (depth > 0) {
    openRe.lastIndex = cursor;
    closeRe.lastIndex = cursor;
    const nextOpen = openRe.exec(raw);
    const nextClose = closeRe.exec(raw);
    if (!nextClose) return null; // malformed HTML, bail out safely
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      cursor = nextOpen.index + nextOpen[0].length;
    } else {
      depth--;
      cursor = nextClose.index + nextClose[0].length;
      if (depth === 0) {
        return { start: ltBefore, end: cursor, tagName };
      }
    }
  }
  return null;
}

/** Best-effort sync of the human-readable text inside an inline element. */
function findVisibleSpan(raw, blockStart, blockEnd, classNames) {
  for (const cls of classNames) {
    const re = new RegExp(
      `class="${cls}"[^>]*>([\\s\\S]*?)</(?:span|div)>`
    );
    const slice = raw.slice(blockStart, blockEnd);
    const m = re.exec(slice);
    if (m) {
      return {
        start: blockStart + m.index + m[0].indexOf('>') + 1,
        end: blockStart + m.index + m[0].lastIndexOf('</'),
      };
    }
  }
  return null;
}

function parseInlineItems(raw, markers) {
  const items = [];
  let m;
  let idx = 0;
  INLINE_ONCLICK_RE.lastIndex = 0;
  while ((m = INLINE_ONCLICK_RE.exec(raw))) {
    const [full, name, price, img, desc] = m;
    const onclickStart = m.index;
    const onclickEnd = m.index + full.length;
    const owner = findOwningElement(raw, onclickStart);
    const ctx = markerContextAt(markers, onclickStart);

    let nameSpan = null;
    let priceSpan = null;
    if (owner) {
      nameSpan = findVisibleSpan(raw, owner.start, owner.end, ['item-name']);
      priceSpan = findVisibleSpan(raw, owner.start, owner.end, [
        'item-price',
        'deal-price',
        'highlight-price',
        'promo-card-price',
      ]);
    }

    items.push({
      id: `inline-${idx++}`,
      kind: 'inline',
      name: unescapeJsString(name),
      price: unescapeJsString(price),
      img: unescapeJsString(img),
      desc: unescapeJsString(desc),
      note: '',
      section: ctx.section,
      page: ctx.page,
      sizes: null,
      _onclick: { start: onclickStart, end: onclickEnd },
      _nameSpan: nameSpan,
      _priceSpan: priceSpan,
    });
  }
  return items;
}

/** Split the inside of `[ ... ]` into individual top-level `{...}` object strings with offsets. */
function splitObjects(raw, arrStart, arrEnd) {
  const objs = [];
  let depth = 0;
  let start = -1;
  for (let i = arrStart; i < arrEnd; i++) {
    const c = raw[i];
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        objs.push({ start, end: i + 1, text: raw.slice(start, i + 1) });
        start = -1;
      }
    }
  }
  return objs;
}

function parseObjectFields(text) {
  const fields = {};
  const re = /(\w+)\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(-?[\d.]+|—))\s*,?/g;
  let m;
  while ((m = re.exec(text))) {
    const key = m[1];
    const val = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    fields[key] = val;
  }
  return fields;
}

function parseDataItems(raw) {
  const items = [];

  for (const arrDef of DATA_ARRAYS) {
    const declRe = new RegExp(`const\\s+${arrDef.name}\\s*=\\s*\\[`);
    const declMatch = declRe.exec(raw);
    if (!declMatch) continue;

    const bracketOpen = declMatch.index + declMatch[0].length - 1;
    // find matching closing bracket for the array
    let depth = 0;
    let closeIdx = -1;
    for (let i = bracketOpen; i < raw.length; i++) {
      if (raw[i] === '[') depth++;
      else if (raw[i] === ']') {
        depth--;
        if (depth === 0) {
          closeIdx = i;
          break;
        }
      }
    }
    if (closeIdx === -1) continue;

    const objs = splitObjects(raw, bracketOpen, closeIdx);
    objs.forEach((obj, i) => {
      const fields = parseObjectFields(obj.text);
      const item = {
        id: `data-${arrDef.name}-${i}`,
        kind: 'data',
        arrayName: arrDef.name,
        shape: arrDef.shape,
        name: unescapeJsString(fields.name || ''),
        price: arrDef.shape === 'simple' ? unescapeJsString(fields.price || '') : '',
        img: unescapeJsString(fields.img || ''),
        desc: '',
        note: unescapeJsString(fields.note || ''),
        section: arrDef.section,
        page: 1,
        sizes:
          arrDef.shape === 'pizza'
            ? { p7: fields.p7 || '', p10: fields.p10 || '', p13: fields.p13 || '' }
            : null,
        _object: { start: obj.start, end: obj.end },
      };
      items.push(item);
    });
  }

  return items;
}

function parseMenu(raw) {
  const markers = findMarkers(raw);
  const titles = pageTitles(raw);
  const inline = parseInlineItems(raw, markers);
  const data = parseDataItems(raw);
  const items = [...inline, ...data];

  // Group into a section tree for the UI: page -> section -> items[]
  const pages = {};
  items.forEach((it) => {
    const pageKey = it.page;
    if (!pages[pageKey]) pages[pageKey] = { index: pageKey, title: titles[pageKey] || `Page ${pageKey + 1}`, sections: {} };
    if (!pages[pageKey].sections[it.section]) pages[pageKey].sections[it.section] = [];
    pages[pageKey].sections[it.section].push(it);
  });

  const pageList = Object.keys(pages)
    .sort((a, b) => a - b)
    .map((k) => {
      const p = pages[k];
      return {
        index: p.index,
        title: p.title,
        sections: Object.keys(p.sections).map((secName) => ({
          name: secName,
          items: p.sections[secName],
        })),
      };
    });

  return { raw, items, pages: pageList };
}

/**
 * Re-serialize the whole file given the current (possibly edited) item list.
 * Only items whose `_dirty` flag is true are touched; the rest of the byte
 * stream is left completely untouched, so all styling/structure survives.
 */
function serializeMenu(raw, items) {
  const edits = []; // {start, end, replacement}

  for (const it of items) {
    if (!it._dirty) continue;

    if (it.kind === 'inline') {
      const newOnclick = `onclick="showPreview('${escapeJsSingleQuoted(it.name)}','${escapeJsSingleQuoted(
        it.price
      )}','${escapeJsSingleQuoted(it.img || '')}','${escapeJsSingleQuoted(it.desc || '')}',this)"`;
      edits.push({ start: it._onclick.start, end: it._onclick.end, replacement: newOnclick });

      if (it._nameSpan) {
        edits.push({ start: it._nameSpan.start, end: it._nameSpan.end, replacement: escapeHtml(it.name) });
      }
      if (it._priceSpan) {
        edits.push({ start: it._priceSpan.start, end: it._priceSpan.end, replacement: escapeHtml(it.price) });
      }
    } else if (it.kind === 'data') {
      const parts = [`name: "${escapeJsDoubleQuoted(it.name)}"`];
      if (it.shape === 'pizza') {
        if (it.note) parts.push(`note: "${escapeJsDoubleQuoted(it.note)}"`);
        parts.push(`p7: ${formatNum(it.sizes.p7)}`);
        parts.push(`p10: ${formatNum(it.sizes.p10)}`);
        parts.push(`p13: ${formatNum(it.sizes.p13)}`);
      } else {
        parts.push(`price: "${escapeJsDoubleQuoted(it.price)}"`);
        if (it.note) parts.push(`note: "${escapeJsDoubleQuoted(it.note)}"`);
      }
      if (it.img) parts.push(`img: "${escapeJsDoubleQuoted(it.img)}"`);
      const newObj = `{ ${parts.join(', ')} }`;
      edits.push({ start: it._object.start, end: it._object.end, replacement: newObj });
    }
  }

  if (edits.length === 0) return raw;

  edits.sort((a, b) => b.start - a.start); // apply from the end backwards
  let out = raw;
  for (const e of edits) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  return out;
}

function formatNum(v) {
  if (v === '' || v === undefined || v === null) return '"—"';
  if (v === '—' || /[^0-9.\-]/.test(String(v))) return `"${escapeJsDoubleQuoted(v)}"`;
  return String(v);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * One-time, idempotent patch so the JS builder functions pass along an
 * item's image path to showPreview(). Safe to call on every save; it's a
 * no-op once already patched.
 */
function patchBuilderFunctions(raw) {
  let out = raw;

  const buildListOld =
    "li.onclick = () => showPreview(item.name, item.price, '', '', li);";
  const buildListNew =
    "li.onclick = () => showPreview(item.name, item.price, item.img || '', item.note || '', li);";
  if (out.includes(buildListOld)) {
    out = out.replace(buildListOld, buildListNew);
  }

  const pizzaOld =
    'div.onclick = () => showPreview(item.name, `7": Rs.${item.p7} | 10": Rs.${item.p10} | 13": Rs.${item.p13}`, \'\', item.note||\'\', div);';
  const pizzaNew =
    'div.onclick = () => showPreview(item.name, `7": Rs.${item.p7} | 10": Rs.${item.p10} | 13": Rs.${item.p13}`, item.img || \'\', item.note||\'\', div);';
  if (out.includes(pizzaOld)) {
    out = out.replace(pizzaOld, pizzaNew);
  }

  return out;
}

module.exports = { parseMenu, serializeMenu, patchBuilderFunctions, DATA_ARRAYS };
