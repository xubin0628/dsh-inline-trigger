/**
 * dsh-inline-trigger —— browser half.
 *
 * English below; 中文说明见包内 README.md。
 *
 * ## What the shipped pipeline does
 *
 * `@deepseek-ai/dsh-client-ui-input-trigger` detects a live `/` or `@` token
 * under the caret on every editor commit. Its word-boundary rule
 * (`core/detect.ts`) only accepts a trigger:
 *
 *   - at start-of-draft, or
 *   - after whitespace (newlines included), or
 *   - for `/` only: after punctuation (with URL carve-outs for `:/` and `//`).
 *
 * So `hello /model` and `hello @file` already open the menu, while a trigger
 * typed directly after text — most importantly after Chinese/Japanese/Korean
 * text, where a space is not normally typed — never opens it. That is the
 * "menus only work when the composer is empty" behavior this plugin removes.
 *
 * ## What this plugin does
 *
 * A trigger source cannot influence detection, and the Host decides the rule,
 * so the plugin wraps the per-session `InputTriggerController.track()` that the
 * composer calls after every edit. Before the host's `detectTrigger()` runs,
 * the plugin may hand it a **same-length shadow draft** in which the single
 * character immediately before the trigger is replaced by a boundary character
 * (a space for `@`, `、` for `/`). Detection then succeeds, and every value
 * that escapes detection — trigger, query, span `{start,end}`, `position` — is
 * identical to the real draft because the substitution is length-preserving
 * and sits strictly before the token span. Picks therefore consume/insert at
 * the real offsets with the real draft revision, reference chips, command
 * claims and token consumption all keep working, and nothing in the editor is
 * modified.
 *
 * ## Relaxed boundary policy
 *
 *   - `/` after a non-ASCII letter (CJK, kana, hangul, Cyrillic, accented
 *     Latin, …) opens the command menu. ASCII letters/digits/underscore are
 *     left alone so paths (`src/index.ts`) and URLs do not pop menus.
 *   - `@` after any non-space character except an ASCII word character, `/`,
 *     `:` or `@` opens the reference menu. ASCII word characters are left
 *     alone so email addresses (`a@b.com`) do not pop menus.
 *   - Everything the host already accepts is untouched, `frozen` phases are
 *     respected, and the claimed-command phase still suppresses `/` exactly as
 *     the host does.
 *
 * ## Opt-in escape hatch
 *
 * `localStorage['dsh-inline-trigger:mode'] = 'always'` (page reload) also
 * relaxes the boundary after ASCII words for both triggers; the default
 * `'cjk'` mode keeps email/path protection. URL carve-outs stay in both modes.
 *
 * The patch is installed as an effect on the injected `inputTriggers` service
 * and fully restored when the plugin fiber unloads.
 */
window.__ModuleLoader__.load({
  id: 'dsh-inline-trigger',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    try {
      /* ------------------------------------------------------------------ *
       * Host detection semantics (kept byte-for-byte equivalent to
       * `dsh-client-ui-input-trigger/lib/client.js` so the shadow is judged
       * by the same rules the host will apply).
       * ------------------------------------------------------------------ */
      const WORD_CHAR = /[\p{L}\p{N}_]/u;
      const WHITESPACE = /\s/u;
      /** Word characters whose scripts use spaces: triggers after them stay literal. */
      const ASCII_WORD = /[A-Za-z0-9_]/;
      const AT_BUILTIN = [/(?:^|\s)(@"([^"]*))$/u, /(?:^|\s)(@([^\s]*))$/u];
      const AT_ANY = [/(@"([^"]*))$/u, /(@([^\s]*))$/u];
      /** Non-word, non-space: satisfies the host's `/` boundary without changing `\S`. */
      const SLASH_SHADOW = '\u3001';
      /** The host's `@` rule accepts only start-of-draft or whitespace before the token. */
      const AT_SHADOW = ' ';
      /** Opt-in escape hatch: `"always"` relaxes the boundary after ASCII words too. */
      const MODE_KEY = 'dsh-inline-trigger:mode';

      /**
       * Read the opt-in mode from page storage. Default `"cjk"` protects email
       * addresses and code paths; `"always"` hands every non-space position to
       * the menus. Unreadable storage falls back to the safe default.
       * @returns {'cjk'|'always'} the active mode.
       */
      function readMode() {
        try {
          const value = window.localStorage.getItem(MODE_KEY);
          return value === 'always' ? 'always' : 'cjk';
        } catch {
          return 'cjk';
        }
      }

      /**
       * The host's `boundaryOk` for a `/` at `index` (see core/detect.ts).
       * @param {string} draft - full draft text.
       * @param {number} index - candidate trigger index.
       * @returns {boolean} whether the host opens a menu for it.
       */
      function boundaryOk(draft, index) {
        if (index === 0) return true;
        const prev = draft.charAt(index - 1);
        if (WHITESPACE.test(prev)) return true;
        if (WORD_CHAR.test(prev)) return false;
        if (prev === '/') return false;
        if (prev === ':' && index >= 2 && !WHITESPACE.test(draft.charAt(index - 2))) return false;
        return true;
      }

      /**
       * The host's slash scan: does the host detect a `/` token at the caret?
       * @param {string} draft - full draft text.
       * @param {number} caret - caret offset.
       * @returns {number} the detected trigger index, or -1.
       */
      function builtinSlashHit(draft, caret) {
        for (let i = caret - 1; i >= 0; i -= 1) {
          const ch = draft.charAt(i);
          if (WHITESPACE.test(ch)) return -1;
          if (ch !== '/') continue;
          if (boundaryOk(draft, i)) return i;
        }
        return -1;
      }

      /**
       * Whether the host's `@` grammar already finds a token ending at the caret.
       * @param {string} before - draft slice `[0, caret)`.
       * @returns {boolean} whether the host detects it.
       */
      function atBuiltinHit(before) {
        return AT_BUILTIN.some((re) => re.test(before));
      }

      /**
       * Start offset of the `@` token ending at the caret, matching the host's
       * quoted-first grammar but without the whitespace requirement.
       * @param {string} before - draft slice `[0, caret)`.
       * @returns {number|null} token start, or null when there is no token.
       */
      function atTokenStart(before) {
        for (const re of AT_ANY) {
          const match = re.exec(before);
          if (match !== null && match[1] !== undefined) return before.length - match[1].length;
        }
        return null;
      }

      /**
       * Replace one character of the shadow draft.
       * @param {string} draft - draft text.
       * @param {number} index - character index.
       * @param {string} char - replacement (must be one UTF-16 code unit).
       * @returns {string} the shadow draft.
       */
      function replaceAt(draft, index, char) {
        return draft.slice(0, index) + char + draft.slice(index + 1);
      }

      /**
       * Relaxed boundary for `/`: `"cjk"` only extends the boundary past
       * non-ASCII word characters so paths, words and URLs keep their literal
       * slash; `"always"` extends it past ASCII words too (URL carve-outs stay).
       * @param {string} draft - draft text.
       * @param {number} index - candidate trigger index.
       * @param {'cjk'|'always'} mode - boundary mode.
       * @returns {boolean} whether this plugin opens the menu there.
       */
      function slashBoundaryAcceptable(draft, index, mode) {
        if (index <= 0) return false;
        const prev = draft.charAt(index - 1);
        if (WHITESPACE.test(prev)) return false;
        if (prev === '/') return false;
        if (prev === ':' && index >= 2 && !WHITESPACE.test(draft.charAt(index - 2))) return false;
        if (mode === 'always') return true;
        if (!WORD_CHAR.test(prev)) return false;
        if (ASCII_WORD.test(prev)) return false;
        return true;
      }

      /**
       * Relaxed boundary for `@`: whitespace is already the host's rule, so
       * only other positions need a decision. `"cjk"` keeps ASCII words (email
       * protection) and URL/sigil punctuation literal; `"always"` only keeps
       * the URL-ish punctuation.
       * @param {string} draft - draft text.
       * @param {number} start - candidate token start.
       * @param {'cjk'|'always'} mode - boundary mode.
       * @returns {boolean} whether this plugin opens the menu there.
       */
      function atBoundaryAcceptable(draft, start, mode) {
        if (start <= 0) return false;
        const prev = draft.charAt(start - 1);
        if (WHITESPACE.test(prev)) return false;
        if (prev === '/' || prev === ':') return false;
        if (mode === 'always') return true;
        if (ASCII_WORD.test(prev)) return false;
        if (prev === '@') return false;
        return true;
      }

      /**
       * Build the same-length shadow draft the host should detect instead, or
       * return `draft` unchanged when the host already detects the token (or
       * should not detect anything here).
       * @param {string} draft - full draft text.
       * @param {number} caret - caret offset into `draft`.
       * @param {{tier?: string}|undefined|null} guard - host availability tier.
       * @param {'cjk'|'always'} [mode] - boundary mode, defaults to `"cjk"`.
       * @returns {string} the draft to hand to the host tracker.
       */
      function shadowDraft(draft, caret, guard, mode) {
        if (typeof draft !== 'string') return draft;
        if (typeof caret !== 'number' || !Number.isInteger(caret)) return draft;
        if (caret < 1 || caret > draft.length) return draft;
        const boundaryMode = mode === 'always' ? 'always' : 'cjk';
        const tier = guard !== null && typeof guard === 'object' ? guard.tier : undefined;
        if (tier === 'frozen') return draft;

        const before = draft.slice(0, caret);
        if (atBuiltinHit(before)) return draft;

        const atStart = atTokenStart(before);
        if (atStart !== null && atBoundaryAcceptable(draft, atStart, boundaryMode)) {
          return replaceAt(draft, atStart - 1, AT_SHADOW);
        }

        // The host suppresses `/` while a command chip owns the line; keep that.
        if (tier === 'claimed') return draft;
        if (builtinSlashHit(draft, caret) >= 0) return draft;
        for (let i = caret - 1; i >= 1; i -= 1) {
          const ch = draft.charAt(i);
          if (WHITESPACE.test(ch)) break;
          if (ch !== '/') continue;
          if (slashBoundaryAcceptable(draft, i, boundaryMode)) return replaceAt(draft, i - 1, SLASH_SHADOW);
        }
        return draft;
      }

      /**
       * Patch the input-trigger controller class so `track()` receives the
       * shadow draft. The service is patched through `sessionOf` because the
       * composer re-resolves the controller for every editor commit.
       * @param {import('@deepseek-ai/cordis').Context} ctx - client root context.
       */
      function apply(ctx) {
        ctx.inject(['inputTriggers'], (scope) => {
          const service = scope.get('inputTriggers');
          if (service === null || typeof service !== 'object') return;

          scope.effect(() => {
            const serviceProto = Object.getPrototypeOf(service);
            if (serviceProto === null || typeof serviceProto.sessionOf !== 'function') return;

            const originalSessionOf = serviceProto.sessionOf;
            let controllerProto = null;
            let originalTrack = null;
            let patchedTrack = null;

            /** Wrap one controller class exactly once (also across hot reloads). */
            const patchControllerClass = (controller) => {
              if (controller === null || typeof controller !== 'object') return;
              const proto = Object.getPrototypeOf(controller);
              if (proto === null || proto === controllerProto || typeof proto.track !== 'function') return;
              if (controllerProto !== null && patchedTrack !== null && controllerProto.track === patchedTrack) {
                controllerProto.track = originalTrack;
              }
              controllerProto = proto;
              originalTrack = proto.track;
              patchedTrack = function patchedTrack(draft, caret, guard, draftRev) {
                let next = draft;
                try {
                  next = shadowDraft(draft, caret, guard, readMode());
                } catch (error) {
                  console.error('[dsh-inline-trigger] shadow draft failed, passing the draft through:', error);
                }
                return originalTrack.call(this, next, caret, guard, draftRev);
              };
              proto.track = patchedTrack;
            };

            const patchedSessionOf = function patchedSessionOf(...args) {
              const controller = originalSessionOf.apply(this, args);
              try {
                patchControllerClass(controller);
              } catch (error) {
                console.error('[dsh-inline-trigger] controller patch failed:', error);
              }
              return controller;
            };
            serviceProto.sessionOf = patchedSessionOf;

            return () => {
              if (serviceProto.sessionOf === patchedSessionOf) serviceProto.sessionOf = originalSessionOf;
              if (
                controllerProto !== null
                && patchedTrack !== null
                && originalTrack !== null
                && controllerProto.track === patchedTrack
              ) {
                controllerProto.track = originalTrack;
              }
            };
          }, 'dsh-inline-trigger: inline / and @ boundary');
        });
      }

      exports.apply = apply;
      exports.inject = [];
      // Diagnostics-only export; the Host UI never imports it.
      exports.__shadowDraft = shadowDraft;
      exports.__boundaryOk = boundaryOk;
      exports.__builtinSlashHit = builtinSlashHit;
    } catch (error) {
      try {
        console.warn('[dsh-inline-trigger] failed to initialize, staying inert:', error);
      } catch {}
      exports.apply = function noop() {};
      exports.inject = [];
    }
    return module.exports;
  },
});
