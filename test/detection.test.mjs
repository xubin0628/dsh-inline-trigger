/**
 * Self-contained regression test for the browser half (`client.js`).
 *
 * 1. Loads the real bundle factory through a stubbed `window.__ModuleLoader__`.
 * 2. Re-implements the *installed* host `detectTrigger()` verbatim (copied from
 *    `@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js`) so every shadow
 *    draft is judged by exactly the rules the host will apply.
 * 3. Exercises the `apply()` patch installation/pass-through/restore with a
 *    Cordis-shaped fake context.
 *
 * Run from the package root: node test/detection.test.mjs
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/* -------------------------------------------------------------------------- */
/* 1. Load the browser bundle factory                                        */
/* -------------------------------------------------------------------------- */

const registrations = [];
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      registrations.push(spec);
    },
  },
};

await import(pathToFileURL(join(here, '..', 'client.js')).href);
assert.equal(registrations.length, 1, 'client.js must register exactly one module');
const spec = registrations[0];
assert.equal(spec.id, 'dsh-inline-trigger');
const exports = spec.factory(() => {
  throw new Error('this plugin must not require any module');
});
assert.equal(typeof exports.apply, 'function');
assert.equal(typeof exports.__shadowDraft, 'function');
const { __shadowDraft: shadowDraft } = exports;

/* -------------------------------------------------------------------------- */
/* 2. The installed host detection, copied from the running DSH build        */
/* -------------------------------------------------------------------------- */

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const WHITESPACE = /\s/u;

function activeAtToken(draft, caret) {
  const beforeCursor = draft.slice(0, caret);
  const quoted = /(?:^|\s)(@"([^"]*))$/u.exec(beforeCursor);
  if (quoted?.[1] !== void 0 && quoted[2] !== void 0) return { prefix: quoted[1], query: quoted[2], quoted: true };
  const plain = /(?:^|\s)(@([^\s]*))$/u.exec(beforeCursor);
  if (plain?.[1] === void 0 || plain[2] === void 0) return undefined;
  return { prefix: plain[1], query: plain[2], quoted: false };
}

function hostBoundaryOk(draft, index, char) {
  if (index === 0) return true;
  const prev = draft.charAt(index - 1);
  if (WHITESPACE.test(prev)) return true;
  if (WORD_CHAR.test(prev)) return false;
  if (char === '/') {
    if (prev === '/') return false;
    if (prev === ':' && index >= 2 && !WHITESPACE.test(draft.charAt(index - 2))) return false;
  }
  return true;
}

function hostDetectTrigger(draft, caret, guard) {
  if (guard.tier === 'frozen') return null;
  const at = activeAtToken(draft, caret);
  if (at !== undefined) {
    const start = caret - at.prefix.length;
    return {
      trigger: '@',
      query: at.query,
      quoted: at.quoted,
      position: draft.search(/\S/) === start ? 'leading' : 'inline',
      span: { start, end: caret },
    };
  }
  for (let i = caret - 1; i >= 0; i -= 1) {
    const ch = draft.charAt(i);
    if (WHITESPACE.test(ch)) return null;
    if (ch !== '/') continue;
    if (guard.tier === 'claimed') continue;
    if (!hostBoundaryOk(draft, i, ch)) continue;
    return {
      trigger: ch,
      query: draft.slice(i + 1, caret),
      quoted: false,
      position: draft.search(/\S/) === i ? 'leading' : 'inline',
      span: { start: i, end: caret },
    };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* 3. Detection cases                                                         */
/* -------------------------------------------------------------------------- */

const plain = { tier: 'plain' };
const claimed = { tier: 'claimed' };
const frozen = { tier: 'frozen' };

const cases = [
  // --- no trigger at all -------------------------------------------------
  { name: 'empty draft', draft: '', caret: 0, guard: plain, shadow: '', hit: null },
  { name: 'plain text no trigger', draft: '你好世界', caret: 4, guard: plain, shadow: '你好世界', hit: null },
  { name: 'caret before trigger', draft: '你好/模型', caret: 2, guard: plain, shadow: '你好/模型', hit: null },

  // --- host already detects: untouched ------------------------------------
  { name: 'slash leading', draft: '/mod', caret: 4, guard: plain, shadow: '/mod', hit: { trigger: '/', start: 0, query: 'mod' } },
  { name: 'slash after ascii space', draft: 'hello /mod', caret: 10, guard: plain, shadow: 'hello /mod', hit: { trigger: '/', start: 6, query: 'mod' } },
  { name: 'at after ascii space', draft: 'hello @fi', caret: 9, guard: plain, shadow: 'hello @fi', hit: { trigger: '@', start: 6, query: 'fi' } },
  { name: 'at leading', draft: '@fi', caret: 3, guard: plain, shadow: '@fi', hit: { trigger: '@', start: 0, query: 'fi' } },
  { name: 'slash after chinese punctuation (host allows)', draft: '你好，/mod', caret: 7, guard: plain, shadow: '你好，/mod', hit: { trigger: '/', start: 3, query: 'mod' } },

  // --- the fix: non-ASCII text directly before the trigger ----------------
  { name: 'slash right after CJK char', draft: '你好/', caret: 3, guard: plain, shadow: '你、/', hit: { trigger: '/', start: 2, query: '' } },
  { name: 'slash right after CJK text', draft: '帮我总结一下/总', caret: 8, guard: plain, shadow: '帮我总结一、/总', hit: { trigger: '/', start: 6, query: '总' } },
  { name: 'at right after CJK char', draft: '你好@', caret: 3, guard: plain, shadow: '你 @', hit: { trigger: '@', start: 2, query: '' } },
  { name: 'at right after CJK query', draft: '参考@会话', caret: 5, guard: plain, shadow: '参 @会话', hit: { trigger: '@', start: 2, query: '会话' } },
  { name: 'at right after CJK quoted', draft: '打开@"my file', caret: 11, guard: plain, shadow: '打 @"my file', hit: { trigger: '@', start: 2, quoted: true, query: 'my file' } },
  { name: 'at after chinese full stop', draft: '好的。@文件', caret: 6, guard: plain, shadow: '好的 @文件', hit: { trigger: '@', start: 3, query: '文件' } },
  { name: 'slash after kana', draft: 'テスト/モ', caret: 5, guard: plain, shadow: 'テス、/モ', hit: { trigger: '/', start: 3, query: 'モ' } },
  { name: 'slash after cyrillic', draft: 'тест/', caret: 5, guard: plain, shadow: 'тес、/', hit: { trigger: '/', start: 4, query: '' } },

  // --- protections -------------------------------------------------------
  { name: 'email: at after ascii word stays literal', draft: 'mail:a@b.com', caret: 11, guard: plain, shadow: 'mail:a@b.com', hit: null },
  { name: 'word: slash after ascii word stays literal', draft: 'src/index.ts', caret: 9, guard: plain, shadow: 'src/index.ts', hit: null },
  { name: 'url: https:// stays literal', draft: '看 https://exa', caret: 12, guard: plain, shadow: '看 https://exa', hit: null },
  { name: 'url: at after slash stays literal', draft: 'https://x/@u', caret: 11, guard: plain, shadow: 'https://x/@u', hit: null },
  { name: 'at after colon/digits stays literal', draft: '时间:10@', caret: 6, guard: plain, shadow: '时间:10@', hit: null },

  // --- phases ------------------------------------------------------------
  { name: 'frozen phase untouched', draft: '你好/', caret: 3, guard: frozen, shadow: '你好/', hit: null },
  { name: 'claimed phase: slash suppressed', draft: '你好/', caret: 3, guard: claimed, shadow: '你好/', hit: null },
  { name: 'claimed phase: at still relaxed', draft: '你好@', caret: 3, guard: claimed, shadow: '你 @', hit: { trigger: '@', start: 2, query: '' } },

  // --- opt-in "always" mode ---------------------------------------------
  { name: 'always: slash after ascii word', draft: 'hello/', caret: 6, guard: plain, mode: 'always', shadow: 'hell、/', hit: { trigger: '/', start: 5, query: '' } },
  { name: 'always: at after ascii word', draft: 'hello@', caret: 6, guard: plain, mode: 'always', shadow: 'hell @', hit: { trigger: '@', start: 5, query: '' } },
  { name: 'always: email still opens (opt-in tradeoff)', draft: 'a@b', caret: 3, guard: plain, mode: 'always', shadow: ' @b', hit: { trigger: '@', start: 1, query: 'b' } },
  { name: 'always: url slash still literal', draft: 'https://x', caret: 9, guard: plain, mode: 'always', shadow: 'https://x', hit: null },
  { name: 'always: url path slash opens (opt-in cost)', draft: 'see https://x/y', caret: 15, guard: plain, mode: 'always', shadow: 'see https://、/y', hit: { trigger: '/', start: 13, query: 'y' } },
  { name: 'always: frozen still untouched', draft: '你好/', caret: 3, guard: frozen, mode: 'always', shadow: '你好/', hit: null },
  { name: 'always: claimed slash still suppressed', draft: '你好/', caret: 3, guard: claimed, mode: 'always', shadow: '你好/', hit: null },
];

let failures = 0;
for (const testCase of cases) {
  const { draft, caret, guard } = testCase;
  let shadow;
  try {
    shadow = shadowDraft(draft, caret, guard, testCase.mode);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${testCase.name}: shadowDraft threw`, error);
    continue;
  }
  const hostHit = hostDetectTrigger(shadow, caret, guard);
  const hostHitReal = hostDetectTrigger(draft, caret, guard);

  const problems = [];
  if (shadow.length !== draft.length) problems.push(`shadow length ${shadow.length} != ${draft.length}`);
  if (shadow !== testCase.shadow) {
    problems.push(`shadow ${JSON.stringify(shadow)} != expected ${JSON.stringify(testCase.shadow)}`);
  }
  if (testCase.hit === null) {
    if (hostHit !== null) problems.push(`expected no host hit, got ${JSON.stringify(hostHit)}`);
  } else {
    if (hostHit === null) problems.push('expected a host hit, got none');
    else {
      if (hostHit.trigger !== testCase.hit.trigger) problems.push(`trigger ${hostHit.trigger} != ${testCase.hit.trigger}`);
      if (hostHit.span.start !== testCase.hit.start) problems.push(`start ${hostHit.span.start} != ${testCase.hit.start}`);
      if (hostHit.span.end !== caret) problems.push(`end ${hostHit.span.end} != caret ${caret}`);
      if (testCase.hit.query !== undefined && hostHit.query !== testCase.hit.query) {
        problems.push(`query ${JSON.stringify(hostHit.query)} != ${JSON.stringify(testCase.hit.query)}`);
      }
      if (testCase.hit.quoted !== undefined && hostHit.quoted !== testCase.hit.quoted) {
        problems.push(`quoted ${hostHit.quoted} != ${testCase.hit.quoted}`);
      }
      if (shadow !== draft && hostHitReal !== null) problems.push('shadow was applied although the host already detects the real draft');
    }
  }
  if (problems.length > 0) {
    failures += 1;
    console.error(`FAIL ${testCase.name}\n  draft=${JSON.stringify(draft)} caret=${caret}\n  shadow=${JSON.stringify(shadow)}\n  ${problems.join('\n  ')}`);
  } else {
    console.log(`ok   ${testCase.name}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 4. Patch plumbing with a Cordis-shaped fake context                        */
/* -------------------------------------------------------------------------- */

function makeFakeRuntime() {
  const calls = [];
  class FakeController {
    track(draft, caret, guard, rev) {
      calls.push({ draft, caret, guard, rev });
    }
  }
  class FakeService {
    sessionOf() {
      return controller;
    }
  }
  const controller = new FakeController();
  const service = new FakeService();
  const effects = [];
  const ctx = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['inputTriggers']);
      callback({
        get(name) {
          assert.equal(name, 'inputTriggers');
          return service;
        },
        effect(execute) {
          const cleanup = execute();
          effects.push(cleanup);
          return () => {};
        },
      });
    },
  };
  return { ctx, service, controller, calls, effects };
}

{
  const runtime = makeFakeRuntime();
  exports.apply(runtime.ctx);

  // The plugin must patch sessionOf and leave the host return value intact.
  assert.equal(runtime.service.sessionOf(), runtime.controller);
  runtime.controller.track('你好/', 3, plain, 7);
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].draft, '你、/', 'composer track() must receive the shadow draft');
  assert.equal(runtime.calls[0].caret, 3);
  assert.equal(runtime.calls[0].rev, 7);

  // A draft the host already handles must pass through untouched.
  runtime.controller.track('/mod', 4, plain, 8);
  assert.equal(runtime.calls[1].draft, '/mod');

  // Cleanup restores the host methods.
  const cleanup = runtime.effects[0];
  cleanup();
  runtime.controller.track('你好/', 3, plain, 9);
  assert.equal(runtime.calls.at(-1).draft, '你好/', 'after dispose the host track() is restored');
  console.log('ok   patch install / pass-through / restore');
}

/* -------------------------------------------------------------------------- */
/* 5. Failure-path safety                                                     */
/* -------------------------------------------------------------------------- */

{
  const runtime = makeFakeRuntime();
  exports.apply(runtime.ctx);
  // A shadowDraft failure must never break the composer: the original call is
  // still forwarded. (shadowDraft itself is defensive; simulate via a caret
  // that is not an integer.)
  runtime.controller.track('你好/', Number.NaN, plain, 1);
  assert.equal(runtime.calls.at(-1).draft, '你好/');
  console.log('ok   non-integer caret passes through');
}

/* -------------------------------------------------------------------------- */
/* 6. Clicking a folder descends into it                                      */
/* -------------------------------------------------------------------------- */

/**
 * A controller stand-in that records what `pick()` was asked to do, paired with
 * a menu snapshot shaped like the real `MenuState`. The `action = 'pick'`
 * default mirrors the shipped `InputTriggerController.pick()` exactly, which
 * is what makes a row click arrive as the settling default.
 */
function makePickRuntime(items) {
  const picks = [];
  class FakeController {
    constructor() {
      this.menu = { getSnapshot: () => ({ open: true, groups: [{ source: 'reference', status: 'ready', items }] }) };
    }
    track() {}
    pick(source, index, action = 'pick') {
      picks.push({ source, index, action });
    }
  }
  const controller = new FakeController();
  class FakeService {
    sessionOf() { return controller; }
  }
  const service = new FakeService();
  const effects = [];
  const ctx = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['inputTriggers']);
      callback({
        get: () => service,
        effect(execute) {
          effects.push(execute());
          return () => {};
        },
      });
    },
  };
  return { ctx, service, controller, picks, effects };
}

const folderRow = { name: 'test/', icon: 'folder', drill: true, value: '{"kind":"file","fileKind":"directory"}' };
const fileRow = { name: 'client.js', icon: 'file', value: '{"kind":"file","fileKind":"file"}' };

// A simulated pointer press: the plugin listens on `document` in capture phase.
function pressPointer() {
  const listeners = globalThis.document?._listeners?.pointerdown ?? [];
  for (const listener of listeners) listener({ type: 'pointerdown' });
}
function pressKey() {
  const listeners = globalThis.document?._listeners?.keydown ?? [];
  for (const listener of listeners) listener({ type: 'keydown' });
}

{
  // Minimal document stub: capture-phase listeners only, which is all the
  // plugin registers.
  const listeners = { pointerdown: [], keydown: [] };
  globalThis.document = {
    _listeners: listeners,
    addEventListener(type, fn) {
      if (listeners[type] !== undefined && !listeners[type].includes(fn)) listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      if (listeners[type] === undefined) return;
      const at = listeners[type].indexOf(fn);
      if (at >= 0) listeners[type].splice(at, 1);
    },
  };
}

{
  const runtime = makePickRuntime([folderRow, fileRow]);
  exports.apply(runtime.ctx);
  runtime.service.sessionOf();

  // A click on a folder row descends instead of settling the mention.
  pressPointer();
  runtime.controller.pick('reference', 0);
  assert.deepEqual(runtime.picks.at(-1), { source: 'reference', index: 0, action: 'drill' },
    'clicking a folder row must drill into the folder');
  console.log('ok   click on a folder row drills into it');

  // The flag is consumed: a click followed by a keyboard pick must not leak.
  pressPointer();
  runtime.controller.pick('reference', 0);
  runtime.controller.pick('reference', 0);
  assert.equal(runtime.picks.at(-1).action, 'pick',
    'the pointer flag must be consumed by exactly one pick');
  console.log('ok   pointer flag is consumed once');

  // Enter on a folder must keep the host's settling pick, so a directory stays
  // referenceable as one mention.
  pressKey();
  runtime.controller.pick('reference', 0);
  assert.equal(runtime.picks.at(-1).action, 'pick',
    'Enter on a folder row must still settle the folder mention');
  console.log('ok   keyboard pick on a folder still settles it');

  // Clicking a plain file stays a settling pick.
  pressPointer();
  runtime.controller.pick('reference', 1);
  assert.equal(runtime.picks.at(-1).action, 'pick', 'clicking a file must settle it');
  console.log('ok   click on a file settles it');

  // The chevron already sends an explicit drill; the flag must not change it.
  pressPointer();
  runtime.controller.pick('reference', 0, 'drill');
  assert.equal(runtime.picks.at(-1).action, 'drill', 'an explicit drill action passes through');
  console.log('ok   explicit drill action passes through untouched');

  // Cleanup restores the host pick().
  const cleanup = runtime.effects[0];
  cleanup();
  pressPointer();
  runtime.controller.pick('reference', 0);
  assert.equal(runtime.picks.at(-1).action, 'pick', 'after dispose the host pick() is restored');
  console.log('ok   pick() restored on dispose');
}

if (failures > 0) {
  console.error(`\n${failures} failing case(s)`);
  process.exitCode = 1;
} else {
  console.log(`\nall ${cases.length} detection cases + plumbing checks passed`);
}
