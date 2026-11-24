// mend: a CLI that applies AI-written edits in four formats (unified diff,
// SEARCH/REPLACE blocks, V4A patches and JSON edits) to a tree of text files,
// exactly as SPEC.md specifies. Node 22, standard library only.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function needSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---------- files as lines ----------

interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function joinCreated(lines: string[], finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (finalBreak ? '\n' : '');
}

// ---------- matching (SPEC section 5) ----------

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineMatch(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

interface Found {
  tier: number;
  positions: number[];
}

/** Occurrences of O in lines at the first tier that has one, at or after `from`. */
function findTier(lines: string[], O: string[], strict: boolean, from = 0, mustEndAt: number | null = null): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + O.length <= lines.length; i++) {
      if (mustEndAt !== null && i + O.length !== mustEndAt) continue;
      let ok = true;
      for (let k = 0; k < O.length; k++) {
        if (!lineMatch(lines[i + k]!, O[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

type ItemKind = 'ctx' | 'del' | 'add' | 'slash';
interface Item {
  kind: ItemKind;
  text: string;
}

/** Build the replacement lines for a matched O, honouring context and tier 2 re-indent. */
function buildReplacement(items: Item[], fileLines: string[], pos: number, O: string[], tier: number): string[] {
  const out: string[] = [];
  let oi = 0;
  const F = O.length > 0 ? leadWs(fileLines[pos] ?? '') : '';
  const P = O.length > 0 ? leadWs(O[0]!) : '';
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi++;
    } else if (it.kind === 'del') {
      oi++;
    } else if (it.kind === 'add') {
      let line = it.text;
      // Tier 2 re-indent: a non-blank line of N that starts with P (the leading
      // whitespace of O's first line; an empty P is a prefix of every line)
      // has that prefix replaced by F (the file's own first-line indent).
      if (tier === 2 && line.trim() !== '' && line.startsWith(P)) {
        line = F + line.slice(P.length);
      }
      out.push(line);
    }
  }
  return out;
}

/** Whether a `\` line follows the last ctx/add item of a hunk or chunk. */
function slashAfterLastNew(items: Item[]): boolean {
  let last = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.kind === 'ctx' || items[i]!.kind === 'add') last = i;
  }
  if (last < 0) return false;
  return last + 1 < items.length && items[last + 1]!.kind === 'slash';
}

function itemsON(items: Item[]): { O: string[]; N: string[] } {
  const O: string[] = [];
  const N: string[] = [];
  for (const it of items) {
    if (it.kind === 'ctx' || it.kind === 'del') O.push(it.text);
    if (it.kind === 'ctx' || it.kind === 'add') N.push(it.text);
  }
  return { O, N };
}

// ---------- format detection (section 4) ----------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- JSON edits (section 9) ----------

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    needSafe(p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      needSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- unified diffs (section 6) ----------

interface Hunk {
  a: number;
  items: Item[];
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
  startLine: number;
}

function headerPath(raw: string): string {
  let p = raw;
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return p;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const newSection = (lineNo: number): Section => {
    const s: Section = {
      diffOld: null, diffNew: null, dashOld: null, dashNew: null,
      renameFrom: null, renameTo: null, newFile: false, deletedFile: false,
      hunks: [], startLine: lineNo,
    };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${lineNo}`);
      cur = newSection(lineNo);
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.dashOld !== null) {
        cur = newSection(lineNo);
      }
      cur.dashOld = headerPath(line.slice(4));
      cur.dashNew = headerPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && cur.hunks.length === 0) {
        throw new Exit2(`error: parse ${lineNo + 1}`);
      }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${lineNo}`);
      const items: Item[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') items.push({ kind: 'ctx', text: '' });
        else if (l[0] === ' ') items.push({ kind: 'ctx', text: l.slice(1) });
        else if (l[0] === '-') items.push({ kind: 'del', text: l.slice(1) });
        else if (l[0] === '+') items.push({ kind: 'add', text: l.slice(1) });
        else if (l[0] === '\\') items.push({ kind: 'slash', text: l.slice(1) });
        else break;
        j++;
      }
      while (items.length > 0) {
        const last = items[items.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') items.pop();
        else break;
      }
      cur.hunks.push({ a: parseInt(m[1]!, 10), items });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    let oldP: string | null = null;
    let newP: string | null = null;
    if (s.dashOld !== null || s.dashNew !== null) {
      oldP = s.dashOld;
      newP = s.dashNew;
    } else if (s.renameFrom !== null || s.renameTo !== null) {
      oldP = s.renameFrom;
      newP = s.renameTo;
    } else {
      oldP = s.diffOld;
      newP = s.diffNew;
    }
    const isCreate = oldP === '/dev/null' || s.newFile;
    const isDelete = newP === '/dev/null' || s.deletedFile;
    const effOld = isCreate ? null : oldP;
    const effNew = isDelete ? null : newP;
    if (effOld !== null) needSafe(effOld);
    if (effNew !== null) needSafe(effNew);
    if (isCreate) {
      const target = effNew ?? effOld;
      if (target === null) throw new Fail('missing', '');
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const outLines: string[] = [];
      let lastAddSlash = false;
      for (const h of s.hunks) {
        for (let k = 0; k < h.items.length; k++) {
          const it = h.items[k]!;
          if (it.kind === 'add') {
            outLines.push(it.text);
            lastAddSlash = k + 1 < h.items.length && h.items[k + 1]!.kind === 'slash';
          }
        }
      }
      tree.now.set(target, joinCreated(outLines, !lastAddSlash));
      return;
    }
    if (isDelete) {
      const target = effOld;
      if (target === null) throw new Fail('missing', '');
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    if (effOld === null || effNew === null) throw new Fail('missing', effOld ?? effNew ?? '');
    const srcText = tree.get(effOld);
    if (srcText === null) throw new Fail('missing', effOld);
    const isMove = effOld !== effNew;
    if (isMove && tree.get(effNew) !== null) throw new Fail('exists', effNew);
    const f = splitFile(srcText);
    let d = 0;
    for (const h of s.hunks) {
      const { O, N } = itemsON(h.items);
      if (O.length === 0) {
        const at = Math.min(h.a + d, f.lines.length);
        const atEnd = at >= f.lines.length;
        f.lines.splice(at, 0, ...N);
        if (atEnd) f.final = !slashAfterLastNew(h.items);
        d += N.length;
        continue;
      }
      const found = findTier(f.lines, O, strict);
      if (found === null) throw new Fail('no-match', effOld);
      const targetPos = h.a - 1 + d;
      let pos = found.positions[0]!;
      let best = Math.abs(pos - targetPos);
      for (const cand of found.positions) {
        const dist = Math.abs(cand - targetPos);
        if (dist < best) {
          best = dist;
          pos = cand;
        }
      }
      const matchedEnd = pos + O.length === f.lines.length;
      const repl = buildReplacement(h.items, f.lines, pos, O, found.tier);
      f.lines.splice(pos, O.length, ...repl);
      if (matchedEnd) {
        if (N.length === 0) f.final = true;
        else f.final = !slashAfterLastNew(h.items);
      }
      d += N.length - O.length;
    }
    const outText = joinFile(f);
    if (isMove) {
      tree.now.set(effOld, null);
      tree.now.set(effNew, outText);
      tree.moves.push([effOld, effNew]);
    } else {
      tree.now.set(effOld, outText);
    }
  };
}

// ---------- SEARCH/REPLACE blocks (section 7) ----------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let k = i - 1; k >= searchFrom; k--) {
      const cand = lines[k]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let sep = -1;
    let end = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (sep < 0 && lines[k]!.trimEnd() === '=======') sep = k;
      else if (sep >= 0 && lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const blockPath = path;
    const blockOld = oldLines;
    const blockNew = newLines;
    edits.push((tree) => {
      needSafe(blockPath);
      if (blockOld.length === 0) {
        if (tree.get(blockPath) !== null) throw new Fail('exists', blockPath);
        tree.now.set(blockPath, joinCreated(blockNew, true));
        return;
      }
      const before = tree.get(blockPath);
      if (before === null) throw new Fail('missing', blockPath);
      const f = splitFile(before);
      const found = findTier(f.lines, blockOld, strict);
      if (found === null) throw new Fail('no-match', blockPath);
      if (found.positions.length > 1) throw new Fail('ambiguous', blockPath);
      const pos = found.positions[0]!;
      const items: Item[] = blockNew.map((t) => ({ kind: 'add' as const, text: t }));
      const repl = buildReplacement(items, f.lines, pos, blockOld, found.tier);
      f.lines.splice(pos, blockOld.length, ...repl);
      tree.now.set(blockPath, joinFile(f));
    });
    prevPath = path;
    searchFrom = end + 1;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------- V4A patches (section 8) ----------

interface VChunk {
  anchor: string | null;
  items: Item[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'del' | 'update';
  path: string;
  lineNo: number;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let chunk: VChunk | null = null;
  // Raw lines of the current section are buffered so trailing blank lines can
  // be dropped before they are interpreted.
  let buf: Array<{ line: string; no: number }> = [];
  const flush = (): void => {
    if (cur === null) return;
    while (buf.length > 0 && blank(buf[buf.length - 1]!.line)) buf.pop();
    if (cur.kind === 'add') {
      for (const { line, no } of buf) {
        if (line.startsWith('+')) cur.addLines.push(line.slice(1));
        else if (line === '') cur.addLines.push('');
        else throw new Exit2(`error: parse ${no}`);
      }
    } else if (cur.kind === 'del') {
      for (const { no } of buf) throw new Exit2(`error: parse ${no}`);
    } else {
      let started = false;
      for (const { line, no } of buf) {
        if (!started && line.startsWith('*** Move to: ')) {
          cur.moveTo = line.slice('*** Move to: '.length).trim();
          started = true;
          continue;
        }
        started = true;
        if (line.startsWith('@@')) {
          chunk = { anchor: line.slice(2).trim() === '' ? null : line.slice(2).trim(), items: [], eof: false };
          cur.chunks.push(chunk);
        } else if (line === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, items: [], eof: true };
            cur.chunks.push(chunk);
          } else chunk.eof = true;
        } else if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
          if (chunk === null) {
            chunk = { anchor: null, items: [], eof: false };
            cur.chunks.push(chunk);
          }
          if (line === '') chunk.items.push({ kind: 'ctx', text: '' });
          else if (line[0] === ' ') chunk.items.push({ kind: 'ctx', text: line.slice(1) });
          else if (line[0] === '-') chunk.items.push({ kind: 'del', text: line.slice(1) });
          else chunk.items.push({ kind: 'add', text: line.slice(1) });
        } else {
          throw new Exit2(`error: parse ${no}`);
        }
      }
      chunk = null;
      if (cur.chunks.length === 0 && cur.moveTo === null) {
        throw new Exit2(`error: parse ${cur.lineNo}`);
      }
    }
    buf = [];
  };
  for (let k = first + 1; k < last; k++) {
    const line = lines[k]!;
    const no = k + 1;
    const isHeader =
      line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
    if (isHeader) {
      flush();
      if (line.startsWith('*** Add File: ')) {
        cur = { kind: 'add', path: line.slice('*** Add File: '.length).trim(), lineNo: no, addLines: [], moveTo: null, chunks: [] };
      } else if (line.startsWith('*** Delete File: ')) {
        cur = { kind: 'del', path: line.slice('*** Delete File: '.length).trim(), lineNo: no, addLines: [], moveTo: null, chunks: [] };
      } else {
        cur = { kind: 'update', path: line.slice('*** Update File: '.length).trim(), lineNo: no, addLines: [], moveTo: null, chunks: [] };
      }
      sections.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${no}`);
    }
    buf.push({ line, no });
  }
  flush();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    needSafe(s.path);
    if (s.moveTo !== null) needSafe(s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, joinCreated(s.addLines, true));
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let anchorPos = -1;
        for (const tier of tiers) {
          for (let k = cursor; k < f.lines.length; k++) {
            if (lineMatch(f.lines[k]!, ch.anchor, tier)) {
              anchorPos = k;
              break;
            }
          }
          if (anchorPos >= 0) break;
        }
        if (anchorPos < 0) throw new Fail('no-match', s.path);
        cursor = anchorPos + 1;
      }
      const { O, N } = itemsON(ch.items);
      if (O.length === 0) {
        const at = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        f.lines.splice(at, 0, ...N);
        cursor = at + N.length;
        continue;
      }
      const found = findTier(f.lines, O, strict, cursor, ch.eof ? f.lines.length : null);
      if (found === null) throw new Fail('no-match', s.path);
      const pos = found.positions[0]!;
      const repl = buildReplacement(ch.items, f.lines, pos, O, found.tier);
      f.lines.splice(pos, O.length, ...repl);
      cursor = pos + repl.length;
    }
    const outText = joinFile(f);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, outText);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, outText);
    }
  };
}

// ---------- the run (sections 1, 2 and 10) ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const changed = new Set<string>();
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)!) changed.add(p);
  }
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (
      tree.original(o) !== null && tree.now.get(o) === null &&
      tree.original(n) === null && tree.now.get(n) !== null &&
      changed.has(o) && changed.has(n) && !usedOld.has(o) && !usedNew.has(n)
    ) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      usedOld.add(o);
      usedNew.add(n);
    }
  }
  for (const p of changed) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
