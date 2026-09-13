/**
 * Scan a tree read-only, classify every .md file by markdown construct, print global counts, and
 * copy a construct-covering sample into ./corpus.
 *
 * **THE TREE IS THE MOCK SOIL, not the real one. Ruled 2026-08-08:** *"this is why we have
 * a fake soil."*
 *
 * The mock tree carries the real tree's construct distribution — measured, and asserted by a test
 * per construct in `app/test/tools/mock-soil.test.ts`. It did not until that day: **seven of eleven
 * constructs were at zero, including frontmatter at 0% against 49% in the real tree**, which would
 * have produced a corpus containing almost nothing that had ever broken.
 *
 * Overridable by argument for the one case that might still want the real tree — a deliberate,
 * named, read-only census — rather than by editing this line, which is how a default becomes a
 * decision nobody made.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = process.env['SOIL_MOCK_DIR']
  ?? path.join(require('os').homedir(), '.soil-viewer-mock',
               path.basename(path.join(__dirname, '..', '..', '..')));
const ROOT = process.argv[2] ?? DEFAULT_ROOT;
if (!fs.existsSync(ROOT)) {
  console.error(`no tree at ${ROOT}\n` +
    `build it with:  npm run mock:soil`);
  process.exit(1);
}
const { S: OUT } = require('./where.cjs')
const CORPUS = path.join(OUT, 'corpus');

function walk(dir, acc) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(p, acc);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      acc.push(p);
    }
  }
  return acc;
}

// strip fenced code blocks so html/link detection isn't fooled by code samples
function stripFences(t) {
  return t.replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[^\n]*$/gm, '');
}

function stripFrontmatter(t) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(t);
  return m && m.index === 0 ? t.slice(m[0].length) : t;
}

function classify(text) {
  const hasFm = /^---\r?\n/.test(text) && /\n---\r?\n/.test(text);
  const body = stripFrontmatter(text);
  const noFence = stripFences(body);
  const lines = noFence.split('\n');
  const c = {};
  c.frontmatter = hasFm;
  c.table = /^ {0,3}\|/m.test(noFence);
  c.inline_link = /(^|[^!])\[[^\]\n]*\]\([^)\n]*\)/.test(noFence);
  c.ref_link_def = /^ {0,3}\[[^\]\n]+\]:[ \t]+\S/m.test(noFence);
  c.ref_link_use = /\[[^\]\n]+\]\[[^\]\n]*\]/.test(noFence);
  c.image = /!\[[^\]]*\]\(/.test(noFence);
  c.fenced_code = /^ {0,3}(```|~~~)/m.test(body);
  c.indented_code = /^\n {4,}\S/m.test(body);
  c.task_list = /^[ \t]*[-*+] \[[ xX]\]/m.test(noFence);
  c.nested_list = /^(?: {2,}|\t)[-*+] /m.test(noFence) || /^(?: {2,}|\t)\d+[.)] /m.test(noFence);
  c.bullet_list = /^[ \t]*[-*+] /m.test(noFence);
  c.bullet_star = /^[ \t]*\* /m.test(noFence);
  c.bullet_plus = /^[ \t]*\+ /m.test(noFence);
  c.ordered_list = /^[ \t]*\d+[.)] /m.test(noFence);
  c.ordered_nonone = /^[ \t]*(?!1[.)])\d+[.)] /m.test(noFence);
  c.raw_html = /<\/?(?:div|span|br|img|details|summary|table|tr|td|th|p|a|b|i|u|sub|sup|kbd|center|figure|iframe|hr|h[1-6])\b[^>]*>/i.test(noFence);
  c.html_comment = /<!--/.test(noFence);
  c.footnote = /\[\^[^\]\n]+\]/.test(noFence);
  c.setext = false;
  for (let i = 1; i < lines.length; i++) {
    if (/^(={2,}|-{2,})\s*$/.test(lines[i]) && /\S/.test(lines[i - 1]) && !/^\s*[-*+>|#]/.test(lines[i - 1])) {
      c.setext = true; break;
    }
  }
  c.hard_break_spaces = /\S[ ]{2,}\n/.test(noFence);
  c.hard_break_backslash = /\S\\\n/.test(noFence);
  c.strikethrough = /~~[^~\n]+~~/.test(noFence);
  c.bold = /\*\*[^*\n]+\*\*/.test(noFence) || /__[^_\n]+__/.test(noFence);
  c.italic_underscore = /(^|[^_\w])_[^_\n]+_([^_\w]|$)/.test(noFence);
  c.italic_star = /(^|[^*\w])\*[^*\n]+\*([^*\w]|$)/.test(noFence);
  c.inline_code = /`[^`\n]+`/.test(noFence);
  c.blockquote = /^ {0,3}> /m.test(noFence);
  c.hr = /^ {0,3}(\*\s*\*\s*\*|-\s*-\s*-|_\s*_\s*_)[\s*_-]*$/m.test(noFence);
  c.heading_atx = /^#{1,6} /m.test(noFence);
  c.bare_url = /(^|\s)https?:\/\/\S+/.test(noFence);
  c.autolink_angle = /<https?:\/\/[^>]+>/.test(noFence);
  c.wikilink = /\[\[/.test(noFence);
  c.tabs = /\t/.test(body);
  c.crlf = /\r\n/.test(text);
  c.no_trailing_newline = !text.endsWith('\n');
  c.multi_trailing_newline = /\n\n$/.test(text);
  c.escaped_char = /\\[*_`\[\]#]/.test(noFence);
  c.emoji_or_box = /[│├└─┌┐┘┴┬┤]/.test(body);
  c.html_entity = /&(?:amp|lt|gt|quot|nbsp|#\d+);/.test(noFence);
  c.fence_with_md = /^ {0,3}(```|~~~)[^\n]*\n(?:[^\n]*\n)*?[ \t]*(#{1,6} |[-*+] |\|)/m.test(body);
  c.dollar_math = /\$\$|\$[^$\n]+\$/.test(noFence);
  return c;
}

const files = walk(ROOT, []);
const counts = {};
const records = [];
for (const f of files) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const c = classify(text);
  records.push({ f, c, size: text.length });
  for (const [k, v] of Object.entries(c)) if (v) counts[k] = (counts[k] || 0) + 1;
}

console.log('TOTAL MD FILES:', records.length);
console.log('--- construct counts across the real tree ---');
const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
for (const [k, v] of sorted) {
  console.log(String(v).padStart(5), (100 * v / records.length).toFixed(1).padStart(5) + '%', k);
}

// ---- corpus selection: greedy cover, prefer soil content over app/vault fixtures ----
const WANT = ['frontmatter','table','inline_link','ref_link_def','ref_link_use','image','fenced_code','fence_with_md',
  'task_list','nested_list','raw_html','html_comment','footnote','setext','hard_break_spaces','hard_break_backslash',
  'strikethrough','bold','italic_underscore','italic_star','inline_code','blockquote','hr','heading_atx','bullet_star',
  'bullet_plus','ordered_list','ordered_nonone','indented_code','tabs','no_trailing_newline','escaped_char',
  'emoji_or_box','html_entity','bare_url','autolink_angle','wikilink','dollar_math','crlf'];

const picked = [];
const covered = new Set();
const isReal = r => !r.f.includes('/node_modules/') && !r.f.includes('/apps/');
// pass 1: for each wanted construct, pick the smallest real file that has it and adds coverage
for (const w of WANT) {
  if (covered.has(w)) continue;
  const cands = records.filter(r => r.c[w] && r.size > 60 && r.size < 40000 && !picked.includes(r));
  const real = cands.filter(isReal);
  const pool = real.length ? real : cands;
  if (!pool.length) { console.log('NO FILE HAS:', w); continue; }
  // prefer the one that covers the most uncovered constructs
  pool.sort((a, b) => {
    const sa = Object.keys(a.c).filter(k => a.c[k] && !covered.has(k)).length;
    const sb = Object.keys(b.c).filter(k => b.c[k] && !covered.has(k)).length;
    return sb - sa || a.size - b.size;
  });
  const chosen = pool[0];
  picked.push(chosen);
  for (const k of Object.keys(chosen.c)) if (chosen.c[k]) covered.add(k);
}
// pass 2: add plain/simple files + a few big typical soil docs
const simple = records.filter(r => isReal(r) && !r.c.table && !r.c.image && !r.c.raw_html && !r.c.task_list &&
  r.size > 200 && r.size < 3000 && !picked.includes(r));
picked.push(...pickSpread(simple, 4));
const typical = records.filter(r => isReal(r) && r.c.frontmatter && r.size > 2000 && r.size < 12000 && !picked.includes(r));
picked.push(...pickSpread(typical, 6));
const noFm = records.filter(r => isReal(r) && !r.c.frontmatter && r.size > 500 && r.size < 12000 && !picked.includes(r));
picked.push(...pickSpread(noFm, 4));
const bigish = records.filter(r => isReal(r) && r.size >= 12000 && r.size < 60000 && !picked.includes(r));
picked.push(...pickSpread(bigish, 3));

function pickSpread(pool, n) {
  if (pool.length <= n) return pool;
  const step = Math.floor(pool.length / n);
  return Array.from({ length: n }, (_, i) => pool[i * step]);
}

fs.rmSync(CORPUS, { recursive: true, force: true });
fs.mkdirSync(CORPUS, { recursive: true });
const manifest = [];
picked.forEach((r, i) => {
  const base = String(i).padStart(2, '0') + '__' + path.relative(ROOT, r.f).replace(/[\/ ]/g, '_');
  fs.copyFileSync(r.f, path.join(CORPUS, base));
  manifest.push({ name: base, source: r.f, size: r.size, constructs: Object.keys(r.c).filter(k => r.c[k]) });
});
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
fs.writeFileSync(path.join(OUT, 'tree-counts.json'), JSON.stringify({ total: records.length, counts }, null, 1));
// full per-file construct table for later extrapolation
fs.writeFileSync(path.join(OUT, 'tree-records.json'), JSON.stringify(records.map(r => ({ f: r.f, size: r.size, c: Object.keys(r.c).filter(k => r.c[k]) }))));
console.log('\nCORPUS SIZE:', picked.length);
console.log('COVERED:', [...covered].sort().join(', '));
console.log('UNCOVERED WANTS:', WANT.filter(w => !covered.has(w)).join(', ') || '(none)');
