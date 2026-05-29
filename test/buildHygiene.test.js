/**
 * v0.26.53: build-hygiene guard against the "works in dev, breaks in the
 * packaged app" path-resolution bug class.
 *
 * Root cause history: v0.26.52 shipped a 500 from `/api/ping` because
 * `main/server/index.js` did `require('../../package.json').version`.
 * In the dev source tree that relative path resolves to the repo-root
 * package.json; in the packaged asar the compiled file sits at
 * `dist-electron/main/server/index.js` and `../../package.json` points at
 * `dist-electron/package.json`, which does not exist. The require threw,
 * the handler 500'd, and the client showed an amber server-hiccup chip.
 *
 * A runtime unit test can't catch this — the tests run against the SOURCE
 * layout, where the relative require happens to resolve. So this is a
 * static source scan instead: read every `main/**` .js file and fail if
 * any of them require a `package.json` (relative OR absolute). The version
 * must always come from Electron's `app.getVersion()`, which is correct in
 * both dev and packaged builds.
 *
 * If this test ever fails: delete the package.json require and read the
 * version from `require('electron').app.getVersion()` instead.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_DIR = path.join(__dirname, '..', 'main');

/** Recursively collect every .js file under a directory. */
function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // skip dotfiles/dirs
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip `//` line comments and block comments so that prose mentioning
 * package.json (like the changelog notes in this very file's siblings)
 * doesn't trip the scan. This is a heuristic, not a full JS parser — it
 * does not understand strings that contain `//`, but the only thing we
 * grep for afterwards is a `require(...package.json...)` call, which would
 * never legitimately live inside a string literal in this codebase.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (keep the char before //)
}

// require('...package.json') or require("...package.json") with any path.
const PACKAGE_JSON_REQUIRE = /require\(\s*['"][^'"]*package\.json['"]\s*\)/;

test('no main/ source file requires a package.json (use app.getVersion)', () => {
  const files = collectJsFiles(MAIN_DIR);
  assert.ok(files.length > 0, 'expected to find some main/ source files');

  const offenders = [];
  for (const file of files) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    if (PACKAGE_JSON_REQUIRE.test(code)) {
      offenders.push(path.relative(MAIN_DIR, file));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'These main/ files require a package.json, which breaks in the packaged ' +
      'asar (the compiled file sits at a different depth than the source). ' +
      'Read the version from require("electron").app.getVersion() instead:\n  ' +
      offenders.join('\n  '),
  );
});

test('comment-stripper does not mask a real require', () => {
  // Sanity check the heuristic: a genuine require must still be detected
  // even when the file is full of comments mentioning package.json.
  const sample = `
    // we used to require('../../package.json') here — don't.
    /* package.json is forbidden */
    const v = require('../../package.json').version;
  `;
  assert.match(stripComments(sample), PACKAGE_JSON_REQUIRE);

  // ...and a file that only MENTIONS it in comments must come back clean.
  const cleanSample = `
    // version comes from app.getVersion(), never package.json
    /* do not require('../../package.json') */
    const v = require('electron').app.getVersion();
  `;
  assert.doesNotMatch(stripComments(cleanSample), PACKAGE_JSON_REQUIRE);
});
