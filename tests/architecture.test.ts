import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The dependency rule, verified instead of promised.
 *
 * In nexo the compiler gave this for free: a project reference cannot point backwards.
 * TypeScript has no such thing — `src/domain` can import Hono and nothing complains — so
 * the rule has to be a test, or it is a comment in a README that stops being true on a
 * tired afternoon.
 *
 * It is written before the eval suite on purpose. Two of the rules below exist to stop
 * mistakes that are only possible once `evals/` exists: a runner that assembles its own
 * stack instead of calling the composition root, and any path at all from `src/` to the
 * golden labels. A guard added after the code it guards is a guard that already lost.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Windows gives backslashes; every rule below is written in posix paths. */
const SEP = /[\\]/g;

interface Module {
  /** Posix-style and relative to the repo root: `src/domain/money.ts`. */
  readonly path: string;
  readonly imports: readonly string[];
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Reads the import graph from the text.
 *
 * A regex is enough and is deliberate: parsing with the TypeScript API would make the
 * test depend on the same toolchain it is auditing. `from '...'` covers static imports,
 * type-only imports and re-exports; the second pattern catches dynamic `import('...')`,
 * which is exactly how someone would sneak past a rule like this.
 */
function readModules(dir: string): Module[] {
  return listTsFiles(join(ROOT, dir)).map((full) => {
    const source = readFileSync(full, 'utf-8');
    const specifiers = [
      ...source.matchAll(/from\s+'([^']+)'/g),
      ...source.matchAll(/import\s*\(\s*'([^']+)'\s*\)/g),
    ].map((m) => m[1]!);
    const path = relative(ROOT, full).replace(SEP, '/');
    return {
      path,
      // Resolved against the importing file, so `../../domain/money` becomes a repo path
      // and the rules below can be written in terms of directories.
      imports: specifiers.map((spec) =>
        spec.startsWith('.')
          ? relative(ROOT, resolve(dirname(full), spec)).replace(SEP, '/')
          : spec,
      ),
    };
  });
}

const isRelative = (spec: string): boolean => spec.startsWith('src/') || spec.startsWith('evals/');
const isNodeBuiltin = (spec: string): boolean => spec.startsWith('node:');

const src = readModules('src');

describe('the dependency rule', () => {
  it('finds the modules it claims to be auditing', () => {
    // Without this, a bad glob would make every rule below pass over an empty list —
    // a green suite that verifies nothing, which is worse than a red one.
    expect(src.length).toBeGreaterThan(20);
    expect(src.map((m) => m.path)).toContain('src/domain/guardrails.ts');
  });

  it('the domain depends on nothing: not a library, not a layer', () => {
    // This is what makes the guardrails testable without a network, a GPU or a clock.
    for (const module of src.filter((m) => m.path.startsWith('src/domain/'))) {
      for (const spec of module.imports) {
        expect(
          isRelative(spec) ? spec.startsWith('src/domain/') : isNodeBuiltin(spec),
          `${module.path} imports ${spec}`,
        ).toBe(true);
      }
    }
  });

  it('the ports know the domain and nothing further out', () => {
    // A port that imports its adapter is not a port: it is a header file for one
    // implementation, and the substitution the eval suite depends on stops being real.
    for (const module of src.filter((m) => m.path.startsWith('src/ports/'))) {
      for (const spec of module.imports.filter(isRelative)) {
        expect(
          spec.startsWith('src/domain/') || spec.startsWith('src/ports/'),
          `${module.path} imports ${spec}`,
        ).toBe(true);
      }
    }
  });

  it('the use case names no adapter, no simulator and no library', () => {
    for (const module of src.filter((m) => m.path.startsWith('src/use-cases/'))) {
      for (const spec of module.imports) {
        expect(
          isRelative(spec)
            ? spec.startsWith('src/domain/') || spec.startsWith('src/ports/')
            : isNodeBuiltin(spec),
          `${module.path} imports ${spec}`,
        ).toBe(true);
      }
    }
  });

  it('only the composition root reaches into the adapters', () => {
    // Adapters may talk to each other inside their own directory — the SGC adapter uses
    // its session and its parsers, and splitting that would be pedantry. What must not
    // happen is the domain, a port, the use case or the simulator naming one.
    const offenders = src
      .filter((m) => !m.path.startsWith('src/adapters/') && m.path !== 'src/composition.ts')
      .flatMap((m) =>
        m.imports.filter((s) => s.startsWith('src/adapters/')).map((s) => `${m.path} -> ${s}`),
      );

    expect(offenders).toEqual([]);
  });

  it('only the composition root builds the simulated ERP', () => {
    // The fake ERP is a test double that happens to run in the demo. The day a real SGC
    // exists, `erpTransport` is passed and nothing else in the app changes — which is
    // only true while no adapter, use case or port has quietly imported the simulator.
    const offenders = src
      .filter((m) => !m.path.startsWith('src/external-mocks/') && m.path !== 'src/composition.ts')
      .flatMap((m) =>
        m.imports.filter((s) => s.startsWith('src/external-mocks/')).map((s) => `${m.path} -> ${s}`),
      );

    expect(offenders).toEqual([]);
  });

  it('nothing under src/ can see the eval suite', () => {
    // Requirement 12, as structure rather than as a promise in the prompt. The agent
    // cannot read what it is graded against if no module it runs inside can name the
    // file. Today `evals/` holds no code and this passes trivially; it is here so that
    // the first import in the wrong direction fails on the commit that writes it.
    const offenders = src.flatMap((m) =>
      m.imports.filter((s) => s.startsWith('evals/')).map((s) => `${m.path} -> ${s}`),
    );

    expect(offenders).toEqual([]);
  });
});

describe('the eval suite runs the production stack', () => {
  /**
   * Requirement 13. An eval that assembles its own agent measures its own agent.
   *
   * The rule is stated over whatever `evals/` contains, so it starts empty and starts
   * biting the moment the runner lands.
   */
  const evalModules = readModules('evals');

  it('nobody there constructs the parts by hand', () => {
    const offenders = evalModules.flatMap((m) =>
      m.imports
        .filter(
          (s) =>
            s.startsWith('src/') &&
            !s.startsWith('src/domain/') &&
            !s.startsWith('src/ports/') &&
            s !== 'src/composition',
        )
        .map((s) => `${m.path} -> ${s}`),
    );

    expect(offenders).toEqual([]);
  });
});
