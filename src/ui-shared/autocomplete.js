/**
 * Autocomplete controller for the Stata terminal webview.
 *
 * Keyboard behaviour (zsh AUTO_MENU style):
 *   1st Tab on ambiguous prefix → extend to longest common prefix, show dropdown
 *   2nd Tab → cycle to first match; 3rd → next; wraps around
 *   ↓/↑          → navigate highlighted item in dropdown
 *   Enter        → accept highlighted item (or run command if nothing highlighted)
 *   Escape       → close dropdown
 *   Mouse click  → accept item
 *
 * UMD: `module.exports` in Node/test; `window.stataAutocomplete` in browser.
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.stataAutocomplete = factory();
  }
}(typeof window !== 'undefined' ? window : global, function () {

  /* ── Pure helpers ──────────────────────────────────────────────────────── */

  /**
   * Return the longest common prefix of a non-empty array of strings
   * (case-insensitive matching, case-preserving from first element).
   */
  function commonPrefix(words) {
    if (!words || !words.length) return '';
    let pfx = words[0];
    for (let i = 1; i < words.length; i++) {
      while (!words[i].toLowerCase().startsWith(pfx.toLowerCase())) {
        pfx = pfx.slice(0, -1);
        if (!pfx) return '';
      }
    }
    return pfx;
  }

  /**
   * Extract the "word" token around the cursor in a textarea/input element.
   * Returns { prefix, start, end } or null if no token.
   */
  function currentToken(inputEl) {
    const pos = inputEl.selectionStart;
    if (pos === null || pos === undefined) return null;
    const text = inputEl.value;
    const before = text.slice(0, pos);
    const beforeMatch = before.match(/([A-Za-z0-9_\.]+)$/);
    if (!beforeMatch) return null;
    const prefix = beforeMatch[1];
    if (!prefix) return null;
    const start = pos - prefix.length;
    const after = text.slice(pos);
    const afterMatch = after.match(/^([A-Za-z0-9_\.]+)/);
    const end = pos + (afterMatch ? afterMatch[1].length : 0);
    return { prefix, start, end };
  }

  /* ── Stateful controller ───────────────────────────────────────────────── */

  /**
   * @param {object}              opts
   * @param {HTMLTextAreaElement} opts.inputEl
   * @param {HTMLElement}         opts.dropdownEl
   * @param {string[]}            opts.variables   - live array; mutations are reflected
   * @param {Document}            [opts.document]  - injected document (defaults to global)
   * @param {function(string):string} [opts.escapeHtml]
   * @param {function}            [opts.onRequestVariables]
   */
  function createController(opts) {
    const inputEl = opts.inputEl;
    const dropdownEl = opts.dropdownEl;
    const doc = opts.document || (typeof document !== 'undefined' ? document : null);
    const escapeHtml = opts.escapeHtml || function (s) {
      return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    };

    let lastCompletion = null;   // rotation state
    let activeIndex = -1;
    let applying = false;

    function getVars() {
      return (opts.variables || []).filter(Boolean);
    }

    function requestVars() {
      if (opts.onRequestVariables) opts.onRequestVariables();
    }

    function applyReplacement(start, end, text) {
      const cur = inputEl.value;
      inputEl.value = cur.slice(0, start) + text + cur.slice(end);
      const cursor = start + text.length;
      inputEl.setSelectionRange(cursor, cursor);
      // Use the same window's Event ctor so JSDOM cross-dom issues are avoided
      const EventCtor = (doc && doc.defaultView && doc.defaultView.Event) || Event;
      inputEl.dispatchEvent(new EventCtor('input', { bubbles: true }));
    }

    function showDropdown(matches, prefixLen) {
      if (!doc) return;
      dropdownEl.innerHTML = '';
      matches.forEach(function (name) {
        const item = doc.createElement('div');
        item.className = 'completion-item';
        item.setAttribute('role', 'option');
        item.dataset.value = name;
        const matchPart = escapeHtml(name.slice(0, prefixLen));
        const restPart = escapeHtml(name.slice(prefixLen));
        item.innerHTML =
          '<i class="codicon codicon-symbol-variable ci-icon"></i>' +
          '<span><span class="ci-match">' + matchPart + '</span>' +
          '<span class="ci-rest">' + restPart + '</span></span>';
        item.addEventListener('mousedown', function (e) {
          e.preventDefault();
          applyItem(name);
        });
        dropdownEl.appendChild(item);
      });
      activeIndex = -1;
      dropdownEl.classList.remove('hidden');
    }

    function close() {
      dropdownEl.classList.add('hidden');
      activeIndex = -1;
      lastCompletion = null;
    }

    function isVisible() {
      return !dropdownEl.classList.contains('hidden');
    }

    function setActive(idx) {
      const items = dropdownEl.querySelectorAll('.completion-item');
      if (!items.length) return;
      if (idx < 0) idx = items.length - 1;
      if (idx >= items.length) idx = 0;
      activeIndex = idx;
      items.forEach(function (el, i) {
        el.classList.toggle('active', i === idx);
        if (i === idx && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'nearest' });
        }
      });
    }

    function applyItem(name) {
      // When rotating, use the rotation start/end; otherwise use currentToken.
      const start = lastCompletion ? lastCompletion.start : null;
      const end = lastCompletion ? lastCompletion.start + lastCompletion.appliedLen : null;
      if (start !== null) {
        applying = true;
        applyReplacement(start, end, name);
        applying = false;
        close();
        return;
      }
      const token = currentToken(inputEl);
      if (!token) { close(); return; }
      applying = true;
      applyReplacement(token.start, token.end, name);
      applying = false;
      close();
    }

    /** Called from the textarea's 'input' event. */
    function onUserInput() {
      if (applying) return;
      lastCompletion = null;
      update();
    }

    /** Refresh dropdown based on current cursor token (called after variables load). */
    function update() {
      if (applying) return;
      const vars = getVars();
      if (!vars.length) { requestVars(); close(); return; }
      const token = currentToken(inputEl);
      if (!token || !token.prefix) { close(); return; }
      const matches = vars.filter(function (n) {
        return n.toLowerCase().startsWith(token.prefix.toLowerCase());
      });
      if (!matches.length) { close(); return; }
      // Exact single match – nothing to show
      if (matches.length === 1 && matches[0].toLowerCase() === token.prefix.toLowerCase()) {
        close(); return;
      }
      showDropdown(matches, token.prefix.length);
    }

    /**
     * Handle a Tab keypress.
     * Returns true if the event was consumed, false if caller should try requestVars.
     */
    function handleTab() {
      const vars = getVars();
      if (!vars.length) { requestVars(); return false; }

      // ── Rotation mode ──────────────────────────────────────────────────────
      if (isVisible() && lastCompletion) {
        const { start, appliedLen, index, matches, prefixLen } = lastCompletion;
        const newIndex = index < 0 ? 0 : (index + 1) % matches.length;
        const replacement = matches[newIndex];
        applying = true;
        applyReplacement(start, start + appliedLen, replacement);
        applying = false;
        lastCompletion = { start, appliedLen: replacement.length, index: newIndex, matches, prefixLen };
        setActive(newIndex);
        return true;
      }

      // ── Fresh Tab ─────────────────────────────────────────────────────────
      const token = currentToken(inputEl);
      if (!token) return false;

      const matches = vars.filter(function (n) {
        return n.toLowerCase().startsWith(token.prefix.toLowerCase());
      });
      if (!matches.length) return false;

      // Unambiguous – complete and close
      if (matches.length === 1) { applyItem(matches[0]); return true; }

      const pfx = commonPrefix(matches);
      const start = token.start;

      if (pfx.length > token.prefix.length) {
        // Extend to common prefix, open dropdown, not yet in rotation
        applying = true;
        applyReplacement(start, token.end, pfx);
        applying = false;
        lastCompletion = { start, appliedLen: pfx.length, index: -1, matches, prefixLen: pfx.length };
        showDropdown(matches, pfx.length);
      } else {
        // Already at common prefix – begin rotation with first match
        const replacement = matches[0];
        applying = true;
        applyReplacement(start, token.end, replacement);
        applying = false;
        lastCompletion = { start, appliedLen: replacement.length, index: 0, matches, prefixLen: pfx.length };
        showDropdown(matches, pfx.length);
        setActive(0);
      }
      return true;
    }

    return {
      handleTab: handleTab,
      close: close,
      applyItem: applyItem,
      setActive: setActive,
      update: update,
      onUserInput: onUserInput,
      isVisible: isVisible,
      getActiveIndex: function () { return activeIndex; },
      getLastCompletion: function () { return lastCompletion; },
    };
  }

  return { commonPrefix: commonPrefix, currentToken: currentToken, createController: createController };
}));
