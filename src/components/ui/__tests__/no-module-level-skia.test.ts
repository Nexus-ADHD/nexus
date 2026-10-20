// Guards the PrimaryPill crash class (Sentry 7633369776).
//
// `const spinnerPath = Skia.Path.Make()` at module scope throws at IMPORT time
// when the Skia JSI binding is unavailable — "Cannot read properties of
// undefined (reading 'Path')" — which takes down every screen importing that
// module, not just the one render path that needs Skia. The fix was to create
// the path lazily; this test stops the pattern coming back.
//
// Detection is AST-based. The first version matched lines at zero indentation
// with a regex, and Greptile showed that `export const x = Skia.Path.Make()`
// and an initializer split across lines both evaded it while recreating the
// exact import-time failure. A parser does not care about indentation or
// line breaks, so those forms are no longer expressible without failing here.
//
// Static rather than behavioural on purpose: the suite is Node-only with no RN
// runtime, so it cannot import a .tsx component and observe the throw.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const UI_DIR = join(__dirname, '..');

/**
 * Names of module-scope bindings whose initializer touches `Skia`, plus a
 * marker for any bare top-level `Skia.*` expression statement.
 *
 * "Module scope" means the statement's parent is the SourceFile — so it runs on
 * import. Anything nested in a function, component, hook or class body is fine:
 * that is exactly the lazy pattern this guard wants people to use.
 */
export function moduleLevelSkiaUses(source: string, fileName = 'f.tsx'): string[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  /** Does this subtree read a property off an identifier named `Skia`? */
  const touchesSkia = (node: ts.Node): boolean => {
    let found = false;
    const walk = (n: ts.Node): void => {
      if (found) return;
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Skia') {
        found = true;
        return;
      }
      ts.forEachChild(n, walk);
    };
    walk(node);
    return found;
  };

  const offenders: string[] = [];

  // Only top-level statements. `export const` is a VariableStatement with an
  // export modifier and the same SourceFile parent, so it is covered here
  // without a special case — which is the bug that motivated the rewrite.
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer && touchesSkia(decl.initializer)) {
          offenders.push(decl.name.getText(sf));
        }
      }
    } else if (ts.isExpressionStatement(stmt) && touchesSkia(stmt.expression)) {
      offenders.push(stmt.expression.getText(sf).split('\n')[0].trim());
    }
  }

  return offenders;
}

describe('no module-level Skia construction in src/components/ui', () => {
  const files = readdirSync(UI_DIR).filter((f) => /\.tsx?$/.test(f));

  it('scans a non-trivial number of files', () => {
    // Silence must not read as success: if the directory or filter ever breaks,
    // an empty file list would make every assertion below pass vacuously.
    expect(files.length).toBeGreaterThan(15);
  });

  it.each(files)('%s builds no Skia object at import time', (file) => {
    const offenders = moduleLevelSkiaUses(readFileSync(join(UI_DIR, file), 'utf8'), file);
    expect(
      offenders,
      `${file} builds a Skia object at module scope. That throws at IMPORT when ` +
        `the Skia JSI binding is unavailable and takes down every screen importing ` +
        `this module (Sentry 7633369776). Create it lazily inside a function ` +
        `instead, as PrimaryPill's getSpinnerPath() does.`,
    ).toEqual([]);
  });
});

describe('moduleLevelSkiaUses sees every module-scope form', () => {
  // The three left-hand cases all recreate the import-time crash. The first
  // regex caught only the first of them.
  it('plain const', () => {
    expect(moduleLevelSkiaUses('const p = Skia.Path.Make();')).toEqual(['p']);
  });

  it('exported const — evaded the original regex', () => {
    expect(moduleLevelSkiaUses('export const p = Skia.Path.Make();')).toEqual(['p']);
  });

  it('initializer split across lines — evaded the original regex', () => {
    expect(
      moduleLevelSkiaUses('export const p =\n  Skia\n    .Path\n    .Make();'),
    ).toEqual(['p']);
  });

  it('bare top-level expression statement', () => {
    expect(moduleLevelSkiaUses('Skia.Path.Make();')).toHaveLength(1);
  });

  it('let and var, not just const', () => {
    expect(moduleLevelSkiaUses('let a = Skia.Path.Make(); var b = Skia.Path.Make();')).toEqual(['a', 'b']);
  });

  it('allows construction inside a function — the lazy pattern', () => {
    expect(moduleLevelSkiaUses('function make() { return Skia.Path.Make(); }')).toEqual([]);
  });

  it('allows a lazy singleton', () => {
    const src = `
      let cached: unknown = null;
      export function get() {
        if (!cached) cached = Skia.Path.Make();
        return cached;
      }
    `;
    expect(moduleLevelSkiaUses(src)).toEqual([]);
  });

  it('allows construction inside a component body and a hook callback', () => {
    const src = `
      export function Pill() {
        const p = useMemo(() => Skia.Path.Make(), []);
        return null;
      }
    `;
    expect(moduleLevelSkiaUses(src)).toEqual([]);
  });

  it('does not fire on the word Skia in a type position or a comment', () => {
    const src = `
      // Skia.Path.Make() at module scope is the bug this guards.
      let p: ReturnType<typeof Skia.Path.Make> | null = null;
    `;
    expect(moduleLevelSkiaUses(src)).toEqual([]);
  });

  it('parses TSX without choking on JSX', () => {
    expect(moduleLevelSkiaUses('export const A = () => <View />;', 'A.tsx')).toEqual([]);
  });
});
