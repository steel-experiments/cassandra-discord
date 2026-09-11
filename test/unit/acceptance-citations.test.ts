import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Guard the contributor acceptance checklist against silent citation drift.
 *
 * `contributor-docs/acceptance-checklist.md` promises that every cited test title
 * resolves in the file it names. Evidence docs of this shape had accumulated
 * inaccuracies before (truncated titles, wrong files, a cited test that did not
 * exist). This test parses each `file — "title"` pair and asserts the title
 * exists as an it()/test()/describe() subject in the named file, so the
 * checklist cannot drift again without failing `npm test`.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface Pair {
  file: string;
  title: string;
  doc: string;
}

const FILE_TOKEN = /`((?:test|src)\/[^`]+\.ts)(?::\d+)?`/g;
const QUOTED = /"([^"]{4,180})"/g;

/** Extract every (file, title) pair from a markdown doc, skipping fixture comments. */
function extractPairs(markdown: string, doc: string): Pair[] {
  const pairs: Pair[] = [];
  for (const line of markdown.split('\n')) {
    const tokens: { kind: 'file' | 'quote'; value: string; at: number }[] = [];
    let m: RegExpExecArray | null;
    const fileRe = new RegExp(FILE_TOKEN);
    while ((m = fileRe.exec(line)) !== null) {
      tokens.push({ kind: 'file', value: m[1]!, at: m.index });
    }
    const quoteRe = new RegExp(QUOTED);
    while ((m = quoteRe.exec(line)) !== null) {
      tokens.push({ kind: 'quote', value: m[1]!, at: m.index });
    }
    tokens.sort((a, b) => a.at - b.at);
    let currentFile: string | null = null;
    for (const tk of tokens) {
      if (tk.kind === 'file') {
        currentFile = tk.value;
      } else if (currentFile) {
        // Skip explicit fixture comments: `(fixture comment: "…")`.
        const before = line.slice(0, tk.at);
        if (/fixture comment:\s*$/.test(before)) continue;
        pairs.push({ file: currentFile, title: tk.value, doc });
      }
    }
  }
  return pairs;
}

/** True when title appears as an it()/test()/describe() subject in the file. */
function titleResolves(file: string, title: string): boolean {
  if (!existsSync(file)) return false;
  const src = readFileSync(file, 'utf8');
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:it|test|describe)\\(['"\`]${escaped}`).test(src);
}

function allPairs(): Pair[] {
  const docs = [
    ['contributor-docs/acceptance-checklist.md', 'acceptance-checklist.md'],
  ] as const;
  const out: Pair[] = [];
  for (const [rel, name] of docs) {
    const md = readFileSync(ROOT + rel, 'utf8');
    out.push(...extractPairs(md, name));
  }
  return out;
}

describe('evidence-doc citation accuracy', () => {
  const pairs = allPairs();

  it('every cited test file exists', () => {
    const files = new Set(pairs.map((p) => p.file));
    const missing = [...files].filter((f) => !existsSync(ROOT + f));
    expect(missing, `cited files that do not exist: ${missing.join(', ')}`).toEqual([]);
  });

  it('every cited title resolves verbatim in its cited file', () => {
    const offenders = pairs
      .filter((p) => !titleResolves(ROOT + p.file, p.title))
      .map((p) => `${p.doc}: ${p.file} — "${p.title}"`);
    expect(
      offenders,
      `citations whose title is not an it/test/describe in the cited file:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the acceptance checklist carries a substantial number of citations', () => {
    // Guards against the parser silently matching nothing if the doc format changes.
    // The checklist cites 145 (file, title) pairs at the time of writing; 120 is
    // the floor, so a moderate edit cannot pass by accident while a format or
    // parser change that matches nothing fails.
    expect(
      pairs.length,
      `expected contributor-docs/acceptance-checklist.md to cite more than 120 tests; the parser found ${pairs.length}`,
    ).toBeGreaterThan(120);
  });
});
