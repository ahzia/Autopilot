// SPDX-License-Identifier: MIT
// Path globs for policy decisions: sensitive/protected/allowed paths and task ownership.
//
// Patterns always match the full repo-relative POSIX path, anchored at the root:
//   *       any characters except "/"
//   ?       one character except "/"
//   [abc]   character class; ranges [a-z]; negation [!abc] or [^abc]; never matches "/"
//   {a,b}   alternatives (may nest); a group without a top-level comma is literal
//   **      as a whole segment: any number of directories, including none.
//             "**/x" matches "x" and "a/b/x"; "a/**" matches "a" itself and everything
//             under it; "a/**/b" matches "a/b" and "a/x/y/b".
//           inside a segment ("src/**.ts") it is the same as "*" and never crosses "/",
//             as in bash, .gitignore and minimatch; write "src/**/*.ts" for any depth.
//   \x      the character x, literally
// A pattern with no "/" and no "**" segment (e.g. "*.pem", "CLAUDE.md") therefore matches
// only at the root; write "**/*.pem" for any depth. Dotfiles get no special treatment.
// A leading "./" or "/" is ignored; a trailing "/" means "everything under it".
// ".." segments are not resolved: such a pattern matches no repo path.

export interface GlobOptions {
  /**
   * Match case-insensitively. Policy code uses this for sensitive/protected paths:
   * on case-insensitive filesystems (macOS default) "claude.md" is CLAUDE.md.
   */
  nocase?: boolean;
}

export class GlobError extends Error {}

/** Brace-expansion cap; real policy globs stay far below it. */
const MAX_ALTERNATIVES = 256;
const CACHE_LIMIT = 2000;
const cache = new Map<string, RegExp>();

/** Compile a glob into a RegExp that tests a whole repo-relative path. Throws GlobError. */
export function globToRegExp(glob: string, opts: GlobOptions = {}): RegExp {
  const key = (opts.nocase ? 'i:' : 'c:') + glob;
  const hit = cache.get(key);
  if (hit) return hit;
  const source = `^(?:${expandBraces(glob).map(alternativeSource).join('|')})$`;
  let re: RegExp;
  try {
    // "s": paths may (rarely) contain newlines; ".*" must still cross them.
    re = new RegExp(source, opts.nocase ? 'si' : 's');
  } catch (err) {
    throw new GlobError(`invalid glob ${JSON.stringify(glob)}: ${(err as Error).message}`);
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, re);
  return re;
}

export function matchesAny(path: string, globs: readonly string[], opts: GlobOptions = {}): boolean {
  const p = normalizePath(path);
  for (const g of globs) if (globToRegExp(g, opts).test(p)) return true;
  return false;
}

/** The paths (in input order) that match at least one glob. */
export function filesMatching(paths: readonly string[], globs: readonly string[], opts: GlobOptions = {}): string[] {
  if (globs.length === 0) return [];
  return paths.filter((p) => matchesAny(p, globs, opts));
}

/**
 * Problems with a list of globs, one message per glob that cannot be compiled (e.g. too
 * many brace alternatives). Empty when every glob is usable; meant for config validation.
 */
export function globProblems(globs: readonly string[]): string[] {
  const problems: string[] = [];
  for (const g of globs) {
    try {
      globToRegExp(g);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  return problems;
}

/**
 * Conservative "could these two tasks edit the same files?" test.
 * An empty list means unknown and overlaps everything; "**" overlaps everything.
 * So does any glob that cannot be placed in the repo tree: absolute ("/x", "C:/x"),
 * home-relative ("~/x") or containing a ".." segment. Such globs match no repo path,
 * so the area they mean is unknown (planner output is not normalized).
 * Otherwise two globs overlap when the literal directory prefix of one (segments before
 * the first segment with a wildcard) is a segment-wise prefix of the other's, or when
 * one glob matches the other's literal prefix path. Case-insensitive on purpose.
 */
export function ownershipOverlaps(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  try {
    const xs = a.flatMap((g) => expandBraces(g));
    const ys = b.flatMap((g) => expandBraces(g));
    if (xs.some(outsideRepoTree) || ys.some(outsideRepoTree)) return true;
    for (const x of xs) for (const y of ys) if (globsOverlap(x, y)) return true;
    return false;
  } catch {
    return true; // cannot reason about the pattern: assume the worst
  }
}

/** Expand "{a,b}" groups (nested allowed) into plain globs. Throws GlobError past the cap. */
export function expandBraces(glob: string): string[] {
  const out: string[] = [];
  const walk = (s: string): void => {
    const group = findBraceGroup(s);
    if (!group) {
      if (out.length >= MAX_ALTERNATIVES) {
        throw new GlobError(`glob ${JSON.stringify(glob)} expands to more than ${MAX_ALTERNATIVES} alternatives`);
      }
      out.push(s);
      return;
    }
    for (const alt of group.alternatives) walk(s.slice(0, group.start) + alt + s.slice(group.end + 1));
  };
  walk(glob);
  return out;
}

// ------------------------------------------------------------------ internals

const NOCASE: GlobOptions = { nocase: true };

function normalizePath(p: string): string {
  let s = p;
  while (s.startsWith('./')) s = s.slice(2);
  return s.replace(/^\/+/, '');
}

/** Normalized path segments of a brace-free glob ("docs/" becomes ["docs", "**"]). */
function splitSegments(glob: string): string[] {
  let g = normalizePath(glob);
  if (g.endsWith('/')) g += '**';
  return g.split('/').filter((s) => s !== '' && s !== '.');
}

const isGlobstar = (segment: string): boolean => /^\*\*+$/.test(segment);

/** Regex source (unanchored) for one brace-free alternative. */
function alternativeSource(alt: string): string {
  const segs: string[] = [];
  for (const s of splitSegments(alt)) {
    // "a/**/**/b" means the same as "a/**/b".
    if (isGlobstar(s) && segs.length > 0 && isGlobstar(segs[segs.length - 1])) continue;
    segs.push(s);
  }
  if (segs.length === 1 && isGlobstar(segs[0])) return '.*';
  let re = '';
  let needSlash = false; // whether the next literal segment must be preceded by "/"
  segs.forEach((s, i) => {
    if (isGlobstar(s)) {
      if (i === 0) re += '(?:.*/)?'; // leading: zero or more directories
      else if (i === segs.length - 1) re += '(?:/.*)?'; // trailing: the directory itself or anything under it
      else re += '/(?:.*/)?'; // middle: zero or more directories in between
      needSlash = false;
    } else {
      if (needSlash) re += '/';
      re += segmentSource(s);
      needSlash = true;
    }
  });
  return re;
}

function segmentSource(seg: string): string {
  let out = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '\\') {
      i++;
      out += i < seg.length ? escapeRegex(seg[i]) : '\\\\';
    } else if (c === '*') {
      while (seg[i + 1] === '*') i++; // "**" inside a segment means "*" (minimatch, .gitignore)
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      const cls = parseClass(seg, i);
      if (cls) {
        out += cls.source;
        i = cls.end;
      } else {
        out += '\\['; // unterminated or invalid class: literal "["
      }
    } else {
      out += escapeRegex(c);
    }
  }
  return out;
}

function parseClass(seg: string, start: number): { source: string; end: number } | null {
  let i = start + 1;
  let negate = false;
  if (seg[i] === '!' || seg[i] === '^') {
    negate = true;
    i++;
  }
  let body = '';
  for (let first = true; i < seg.length; i++, first = false) {
    const c = seg[i];
    if (c === ']' && !first) {
      const source = negate ? `[^/${body}]` : `(?!/)[${body}]`;
      try {
        new RegExp(source); // e.g. reversed range "[z-a]"
      } catch {
        return null;
      }
      return { source, end: i };
    }
    if (c === '\\' && i + 1 < seg.length) {
      i++;
      body += escapeClassChar(seg[i]);
    } else {
      body += c === '-' ? '-' : escapeClassChar(c);
    }
  }
  return null;
}

const escapeRegex = (c: string): string => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const escapeClassChar = (c: string): string => (/[\\\]\[^]/.test(c) ? `\\${c}` : c);

/** Index of the "]" closing the class that starts at `start`, or -1. */
function classEnd(s: string, start: number): number {
  let i = start + 1;
  if (s[i] === '!' || s[i] === '^') i++;
  for (let first = true; i < s.length; i++, first = false) {
    const c = s[i];
    if (c === '/') return -1;
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === ']' && !first) return i;
  }
  return -1;
}

/** First "{...}" group with a top-level comma, skipping escapes and character classes. */
function findBraceGroup(s: string): { start: number; end: number; alternatives: string[] } | null {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '[') {
      const end = classEnd(s, i);
      if (end > 0) i = end;
      continue;
    }
    if (c !== '{') continue;
    let depth = 0;
    const commas: number[] = [];
    for (let j = i + 1; j < s.length; j++) {
      const d = s[j];
      if (d === '\\') {
        j++;
      } else if (d === '[') {
        const end = classEnd(s, j);
        if (end > 0) j = end;
      } else if (d === '{') {
        depth++;
      } else if (d === ',' && depth === 0) {
        commas.push(j);
      } else if (d === '}') {
        if (depth > 0) {
          depth--;
          continue;
        }
        if (commas.length === 0) break; // "{a}" is literal; nested groups are found later
        const alternatives: string[] = [];
        let from = i + 1;
        for (const comma of commas) {
          alternatives.push(s.slice(from, comma));
          from = comma + 1;
        }
        alternatives.push(s.slice(from, j));
        return { start: i, end: j, alternatives };
      }
    }
  }
  return null;
}

/** Lower-cased literal segments before the first segment that contains a wildcard. */
function literalPrefix(glob: string): string[] {
  const out: string[] = [];
  for (const seg of splitSegments(glob)) {
    if (/[*?[{\\]/.test(seg)) break;
    out.push(seg.toLowerCase());
  }
  return out;
}

const isSegmentPrefix = (p: string[], q: string[]): boolean => p.length <= q.length && p.every((s, i) => s === q[i]);

/** Absolute ("/x", "C:\x"), home-relative ("~/x") or ".."-escaping globs (brace-free). */
function outsideRepoTree(glob: string): boolean {
  if (/^(?:[/~]|[A-Za-z]:)/.test(glob)) return true;
  return glob.split(/[/\\]/).some((segment) => segment === '..');
}

function globsOverlap(x: string, y: string): boolean {
  const px = literalPrefix(x);
  const py = literalPrefix(y);
  if (isSegmentPrefix(px, py) || isSegmentPrefix(py, px)) return true;
  return globToRegExp(x, NOCASE).test(py.join('/')) || globToRegExp(y, NOCASE).test(px.join('/'));
}
