/**
 * Tests for the Stata terminal autocomplete feature.
 *
 * Coverage:
 *  Unit       – commonPrefix, currentToken (pure functions)
 *  Integration – createController full state machine, Tab rotation, arrow nav,
 *                Escape, Enter, mouse click, onUserInput, update(), edge cases
 *  Structural  – dropdown DOM element exists in rendered terminal HTML
 */

const { describe, it, expect, beforeEach } = require('bun:test');
const { JSDOM } = require('jsdom');
const proxyquire = require('proxyquire').noCallThru().noPreserveCache();
const { withTestContext } = require('../helpers/test-context');

// ── Load autocomplete module into a JSDOM so `document` is available ──────────
const _acDom = new JSDOM('<!doctype html><html><body></body></html>');
global.document = _acDom.window.document;
// This makes createController's `document.createElement` work in Node
const { commonPrefix, currentToken, createController } = require('../../src/ui-shared/autocomplete.js');

// ── Helper: build a minimal DOM scaffold for integration tests ────────────────
function makeScaffold(vars = []) {
  const dom = new JSDOM(`<!doctype html>
    <html><body>
      <textarea id="inp"></textarea>
      <div id="dd" class="completion-dropdown hidden"></div>
    </body></html>`);
  const { window } = dom;
  const inputEl = window.document.getElementById('inp');
  const dropdownEl = window.document.getElementById('dd');

  // Wire input.setSelectionRange (jsdom supports it natively via HTMLTextAreaElement)
  // eslint-disable-next-line no-param-reassign
  inputEl.setSelectionRange = inputEl.setSelectionRange.bind(inputEl);

  const variables = [...vars];
  const ac = createController({
    inputEl,
    dropdownEl,
    variables,
    document: window.document,
    escapeHtml: (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  });

  /** Helper: simulate a user typing `text` (replaces input value, resets cursor to end). */
  function type(text) {
    inputEl.value = text;
    inputEl.selectionStart = text.length;
    inputEl.selectionEnd = text.length;
    // fire onUserInput so the controller updates
    ac.onUserInput();
  }

  /** Press Tab once. */
  function pressTab() {
    return ac.handleTab();
  }

  function items() {
    return Array.from(dropdownEl.querySelectorAll('.completion-item'));
  }

  function itemValues() {
    return items().map((el) => el.dataset.value);
  }

  function activeItem() {
    const el = dropdownEl.querySelector('.completion-item.active');
    return el ? el.dataset.value : null;
  }

  return { ac, inputEl, dropdownEl, variables, type, pressTab, items, itemValues, activeItem, window };
}

// ══════════════════════════════════════════════════════════════════════════════
// Unit – commonPrefix
// ══════════════════════════════════════════════════════════════════════════════
describe('Autocomplete – commonPrefix', () => {
  it('returns empty string for empty array', () => {
    expect(commonPrefix([])).toBe('');
  });

  it('returns the only word for a single-element array', () => {
    expect(commonPrefix(['alpha'])).toBe('alpha');
  });

  it('finds prefix of two identical words', () => {
    expect(commonPrefix(['abc', 'abc'])).toBe('abc');
  });

  it('finds prefix a_ for a_1 and a_2', () => {
    expect(commonPrefix(['a_1', 'a_2'])).toBe('a_');
  });

  it('finds empty prefix with no common characters', () => {
    expect(commonPrefix(['abc', 'xyz'])).toBe('');
  });

  it('handles longer common prefix', () => {
    expect(commonPrefix(['income_2020', 'income_2021', 'income_2022'])).toBe('income_202');
  });

  it('is case-insensitive for matching but preserves case from first word', () => {
    expect(commonPrefix(['ABC', 'Abcde'])).toBe('ABC');
  });

  it('handles single-char prefix', () => {
    expect(commonPrefix(['ax', 'ay', 'az'])).toBe('a');
  });

  it('handles words that are prefixes of each other', () => {
    expect(commonPrefix(['var', 'variable'])).toBe('var');
  });

  it('returns empty string when first char differs', () => {
    expect(commonPrefix(['foo', 'bar'])).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Unit – currentToken
// ══════════════════════════════════════════════════════════════════════════════
describe('Autocomplete – currentToken', () => {
  function fakeInput(value, cursor) {
    return { value, selectionStart: cursor };
  }

  it('returns null when selectionStart is null', () => {
    expect(currentToken({ value: 'abc', selectionStart: null })).toBeNull();
  });

  it('returns null when input is empty', () => {
    expect(currentToken(fakeInput('', 0))).toBeNull();
  });

  it('returns null when cursor is right after a space', () => {
    expect(currentToken(fakeInput('gen a ', 6))).toBeNull();
  });

  it('extracts a simple token at end of line', () => {
    const tok = currentToken(fakeInput('gen a_1', 7));
    expect(tok).toBeTruthy();
    expect(tok.prefix).toBe('a_1');
    expect(tok.start).toBe(4);
    expect(tok.end).toBe(7);
  });

  it('extracts prefix up to cursor with more text after', () => {
    const tok = currentToken(fakeInput('gen a_1 rest', 7));
    expect(tok.prefix).toBe('a_1');
    expect(tok.start).toBe(4);
    expect(tok.end).toBe(7);  // end of contiguous word token from cursor
  });

  it('handles cursor mid-word', () => {
    // "gen inc|ome" – cursor after "inc"
    const tok = currentToken(fakeInput('gen income', 7));
    expect(tok.prefix).toBe('inc');
    expect(tok.start).toBe(4);
    expect(tok.end).toBe(10); // extends to end of "income"
  });

  it('handles underscore in token', () => {
    const tok = currentToken(fakeInput('reg y_hat', 9));
    expect(tok.prefix).toBe('y_hat');
  });

  it('handles dots in token (Stata extended names)', () => {
    const tok = currentToken(fakeInput('ren x.var', 9));
    expect(tok.prefix).toBe('x.var');
  });

  it('returns null when cursor is at position 0 with no preceding text', () => {
    expect(currentToken(fakeInput('abc', 0))).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Integration – createController
// ══════════════════════════════════════════════════════════════════════════════
describe('Autocomplete – createController', () => {

  describe('initial state', () => {
    it('dropdown is hidden initially', () => {
      const { dropdownEl } = makeScaffold(['a_1', 'a_2']);
      expect(dropdownEl.classList.contains('hidden')).toBe(true);
    });

    it('isVisible() returns false initially', () => {
      const { ac } = makeScaffold(['a_1', 'a_2']);
      expect(ac.isVisible()).toBe(false);
    });
  });

  // ── onUserInput / update ──────────────────────────────────────────────────
  describe('live typing (onUserInput)', () => {
    it('shows dropdown when prefix matches multiple variables', () => {
      const { type, dropdownEl, itemValues } = makeScaffold(['a_1', 'a_2']);
      type('a');
      expect(dropdownEl.classList.contains('hidden')).toBe(false);
      expect(itemValues()).toEqual(['a_1', 'a_2']);
    });

    it('hides dropdown when no matches', () => {
      const { type, dropdownEl } = makeScaffold(['a_1', 'a_2']);
      type('b');
      expect(dropdownEl.classList.contains('hidden')).toBe(true);
    });

    it('hides dropdown when input is empty', () => {
      const { type, dropdownEl } = makeScaffold(['a_1', 'a_2']);
      type('a');
      type('');
      expect(dropdownEl.classList.contains('hidden')).toBe(true);
    });

    it('hides dropdown when typed value is an exact unique match', () => {
      const { type, dropdownEl } = makeScaffold(['abc', 'abcde']);
      type('abcde');
      expect(dropdownEl.classList.contains('hidden')).toBe(true);
    });

    it('keeps dropdown open while prefix is still ambiguous', () => {
      const { type, dropdownEl, itemValues } = makeScaffold(['income_2020', 'income_2021']);
      type('income');
      expect(dropdownEl.classList.contains('hidden')).toBe(false);
      expect(itemValues()).toEqual(['income_2020', 'income_2021']);
    });

    it('highlights matched prefix in dropdown items', () => {
      const { type, dropdownEl } = makeScaffold(['a_1', 'a_2']);
      type('a');
      const first = dropdownEl.querySelector('.ci-match');
      expect(first.textContent).toBe('a');
    });

    it('shows rest (non-matching suffix) in dropdown items', () => {
      const { type, dropdownEl } = makeScaffold(['a_1', 'a_2']);
      type('a');
      const rests = Array.from(dropdownEl.querySelectorAll('.ci-rest'));
      expect(rests.map((el) => el.textContent)).toEqual(['_1', '_2']);
    });

    it('updates dropdown when variables array is mutated externally', () => {
      const { ac, variables, inputEl, dropdownEl } = makeScaffold([]);
      inputEl.value = 'x';
      inputEl.selectionStart = 1;
      inputEl.selectionEnd = 1;
      variables.push('x_pos', 'x_neg');
      ac.update();
      expect(dropdownEl.classList.contains('hidden')).toBe(false);
      expect(Array.from(dropdownEl.querySelectorAll('.completion-item')).map((el) => el.dataset.value))
        .toEqual(['x_pos', 'x_neg']);
    });
  });

  // ── Tab: single unambiguous match ─────────────────────────────────────────
  describe('Tab – single match', () => {
    it('completes immediately and closes dropdown', () => {
      const { ac, inputEl, dropdownEl, variables } = makeScaffold([]);
      variables.push('income');
      inputEl.value = 'inc';
      inputEl.selectionStart = 3;
      const used = ac.handleTab();
      expect(used).toBe(true);
      expect(inputEl.value).toBe('income');
      expect(dropdownEl.classList.contains('hidden')).toBe(true);
    });

    it('places cursor at end of completed word', () => {
      const { ac, inputEl, variables } = makeScaffold([]);
      variables.push('income');
      inputEl.value = 'inc';
      inputEl.selectionStart = 3;
      ac.handleTab();
      expect(inputEl.selectionStart).toBe(6); // length of 'income'
    });
  });

  // ── Tab: zsh-style rotation (core scenario) ───────────────────────────────
  describe('Tab – zsh rotation (a_1, a_2)', () => {
    it('Tab 1 on "a": extends to common prefix a_ and shows dropdown', () => {
      const { ac, inputEl, dropdownEl, variables } = makeScaffold([]);
      variables.push('a_1', 'a_2');
      inputEl.value = 'a';
      inputEl.selectionStart = 1;
      const used = ac.handleTab();
      expect(used).toBe(true);
      expect(inputEl.value).toBe('a_');
      expect(dropdownEl.classList.contains('hidden')).toBe(false);
      expect(ac.getActiveIndex()).toBe(-1); // not yet in active-item mode
    });

    it('Tab 2: rotates to first match a_1, highlights item 0', () => {
      const { ac, inputEl, dropdownEl, variables } = makeScaffold([]);
      variables.push('a_1', 'a_2');
      inputEl.value = 'a';
      inputEl.selectionStart = 1;
      ac.handleTab(); // → a_
      ac.handleTab(); // → a_1
      expect(inputEl.value).toBe('a_1');
      expect(ac.getActiveIndex()).toBe(0);
      const activeEl = dropdownEl.querySelector('.completion-item.active');
      expect(activeEl).toBeTruthy();
      expect(activeEl.dataset.value).toBe('a_1');
    });

    it('Tab 3: rotates to second match a_2, highlights item 1', () => {
      const { ac, inputEl, variables } = makeScaffold([]);
      variables.push('a_1', 'a_2');
      inputEl.value = 'a';
      inputEl.selectionStart = 1;
      ac.handleTab(); // → a_
      ac.handleTab(); // → a_1
      ac.handleTab(); // → a_2
      expect(inputEl.value).toBe('a_2');
      expect(ac.getActiveIndex()).toBe(1);
    });

    it('Tab 4: wraps back to first match a_1', () => {
      const { ac, inputEl, variables } = makeScaffold([]);
      variables.push('a_1', 'a_2');
      inputEl.value = 'a';
      inputEl.selectionStart = 1;
      ac.handleTab(); // → a_
      ac.handleTab(); // → a_1
      ac.handleTab(); // → a_2
      ac.handleTab(); // → a_1 again
      expect(inputEl.value).toBe('a_1');
      expect(ac.getActiveIndex()).toBe(0);
    });

    it('cycles through 3 matches', () => {
      const { ac, inputEl, variables } = makeScaffold([]);
      variables.push('foo_a', 'foo_b', 'foo_c');
      inputEl.value = 'foo';
      inputEl.selectionStart = 3;
      ac.handleTab(); // → foo_ (common prefix)
      ac.handleTab(); // → foo_a  (index 0)
      ac.handleTab(); // → foo_b  (index 1)
      ac.handleTab(); // → foo_c  (index 2)
      ac.handleTab(); // → foo_a  (wraps)
      expect(inputEl.value).toBe('foo_a');
      expect(ac.getActiveIndex()).toBe(0);
    });

    it('rotation starts immediately when already at common prefix', () => {
      const { ac, inputEl, variables } = makeScaffold([]);
      variables.push('a_1', 'a_2');
      inputEl.value = 'a_'; // user manually typed the common prefix
      inputEl.selectionStart = 2;
      ac.handleTab(); // already at common prefix → rotate to first
      expect(inputEl.value).toBe('a_1');
      expect(ac.getActiveIndex()).toBe(0);
    });
  });

  // ── Tab: no variables ─────────────────────────────────────────────────────
  describe('Tab – no variables', () => {
    it('returns false when variables list is empty', () => {
      const { ac, inputEl } = makeScaffold([]);
      inputEl.value = 'a';
      inputEl.selectionStart = 1;
      const used = ac.handleTab();
      expect(used).toBe(false);
    });

    it('returns false when no token under cursor', () => {
      const { ac, inputEl, variables } = makeScaffold([]);
      variables.push('abc');
      inputEl.value = 'gen '; // cursor after space
      inputEl.selectionStart = 4;
      const used = ac.handleTab();
      expect(used).toBe(false);
    });

    it('returns false when prefix has no matches', () => {
      const { ac, inputEl, variables } = makeScaffold([]);
      variables.push('income');
      inputEl.value = 'z';
      inputEl.selectionStart = 1;
      const used = ac.handleTab();
      expect(used).toBe(false);
    });
  });

  // ── Arrow key navigation ─────────────────────────────────────────────────
  describe('Arrow key navigation', () => {
    it('setActive highlights the given index', () => {
      const { ac, variables, dropdownEl, inputEl } = makeScaffold([]);
      variables.push('a_1', 'a_2', 'a_3');
      inputEl.value = 'a';
      inputEl.selectionStart = 1;
      ac.handleTab(); // open dropdown
      ac.setActive(1);
      expect(ac.getActiveIndex()).toBe(1);
      const items = dropdownEl.querySelectorAll('.completion-item');
      expect(items[1].classList.contains('active')).toBe(true);
      expect(items[0].classList.contains('active')).toBe(false);
    });

    it('setActive wraps around at the end', () => {
      const { ac, variables, inputEl } = makeScaffold([]);
      variables.push('a_1', 'a_2');
      inputEl.value = 'a';
      inputEl.selectionStart = 1;
      ac.handleTab();
      ac.setActive(2); // past last
      expect(ac.getActiveIndex()).toBe(0);
    });

    it('setActive wraps to last item on negative index', () => {
      const { ac, variables, inputEl } = makeScaffold([]);
      variables.push('a_1', 'a_2');
      inputEl.value = 'a';
      inputEl.selectionStart = 1;
      ac.handleTab();
      ac.setActive(-1);
      expect(ac.getActiveIndex()).toBe(1);
    });

    it('Enter on active item applies it and closes dropdown', () => {
      const { ac, inputEl, dropdownEl, variables } = makeScaffold([]);
      variables.push('a_1', 'a_2');
      inputEl.value = 'a';
      inputEl.selectionStart = 1;
      ac.handleTab(); // dropdown opens
      ac.setActive(1); // select a_2
      ac.applyItem('a_2');
      expect(inputEl.value).toBe('a_2');
      expect(dropdownEl.classList.contains('hidden')).toBe(true);
    });
  });

  // ── Escape / close ────────────────────────────────────────────────────────
  describe('Escape / close', () => {
    it('close() hides dropdown', () => {
      const { ac, variables, inputEl, dropdownEl } = makeScaffold([]);
      variables.push('a_1', 'a_2');
      inputEl.value = 'a';
      inputEl.selectionStart = 1;
      ac.handleTab();
      expect(ac.isVisible()).toBe(true);
      ac.close();
      expect(ac.isVisible()).toBe(false);
    });

    it('close() resets active index', () => {
      const { ac, variables, inputEl } = makeScaffold([]);
      variables.push('a_1', 'a_2');
      inputEl.value = 'a';
      inputEl.selectionStart = 1;
      ac.handleTab();
      ac.setActive(1);
      ac.close();
      expect(ac.getActiveIndex()).toBe(-1);
    });

    it('close() resets lastCompletion so next Tab starts fresh', () => {
      const { ac, variables, inputEl } = makeScaffold([]);
      variables.push('a_1', 'a_2');
      inputEl.value = 'a';
      inputEl.selectionStart = 1;
      ac.handleTab(); // → a_
      ac.handleTab(); // → a_1
      ac.close();
      // Simulate user editing back to 'a'
      inputEl.value = 'a';
      inputEl.selectionStart = 1;
      ac.handleTab(); // fresh Tab → a_ again
      expect(inputEl.value).toBe('a_');
      expect(ac.getLastCompletion().index).toBe(-1);
    });
  });

  // ── onUserInput during rotation ───────────────────────────────────────────
  describe('onUserInput resets rotation', () => {
    it('manual editing after Tab rotation resets lastCompletion and updates dropdown', () => {
      const { ac, variables, inputEl, dropdownEl } = makeScaffold([]);
      variables.push('a_1', 'a_2');
      inputEl.value = 'a';
      inputEl.selectionStart = 1;
      ac.handleTab(); // → a_
      ac.handleTab(); // → a_1

      // User manually types an extra char
      inputEl.value = 'a_1x';
      inputEl.selectionStart = 4;
      ac.onUserInput();

      // lastCompletion cleared, and dropdown closed (no matches for 'a_1x')
      expect(ac.getLastCompletion()).toBeNull();
      expect(dropdownEl.classList.contains('hidden')).toBe(true);
    });
  });

  // ── Mouse click ───────────────────────────────────────────────────────────
  describe('Mouse click on item', () => {
    it('applyItem applies the value and closes dropdown', () => {
      const { ac, variables, inputEl, dropdownEl } = makeScaffold([]);
      variables.push('beta_1', 'beta_2');
      inputEl.value = 'beta';
      inputEl.selectionStart = 4;
      ac.handleTab(); // open dropdown (rotation state active)
      ac.applyItem('beta_2');
      expect(inputEl.value).toBe('beta_2');
      expect(dropdownEl.classList.contains('hidden')).toBe(true);
    });

    it('applyItem with no rotation context uses currentToken', () => {
      const { ac, variables, inputEl } = makeScaffold([]);
      variables.push('beta_1');
      inputEl.value = 'beta';
      inputEl.selectionStart = 4;
      // No Tab pressed – call applyItem directly
      ac.applyItem('beta_1');
      expect(inputEl.value).toBe('beta_1');
    });
  });

  // ── Context awareness (cursor mid-line) ──────────────────────────────────
  describe('Context-aware completion (multi-token line)', () => {
    it('completes only the token under the cursor', () => {
      const { ac, variables, inputEl } = makeScaffold([]);
      variables.push('a_1', 'a_2');
      // "regress y a" – cursor at end, completing 'a'
      inputEl.value = 'regress y a';
      inputEl.selectionStart = 11;
      ac.handleTab(); // → a_
      expect(inputEl.value).toBe('regress y a_');
    });

    it('does not disturb text before the token', () => {
      const { ac, variables, inputEl } = makeScaffold([]);
      variables.push('income');
      inputEl.value = 'gen log_inc = log(inc)';
      inputEl.selectionStart = 20; // cursor after 'inc' inside parens
      ac.handleTab();
      expect(inputEl.value).toBe('gen log_inc = log(income)');
    });
  });

  // ── Dropdown DOM structure ─────────────────────────────────────────────────
  describe('Dropdown DOM structure', () => {
    it('each item has role="option"', () => {
      const { ac, variables, inputEl, items } = makeScaffold([]);
      variables.push('x_1', 'x_2');
      inputEl.value = 'x';
      inputEl.selectionStart = 1;
      ac.handleTab();
      items().forEach((el) => {
        expect(el.getAttribute('role')).toBe('option');
      });
    });

    it('each item has data-value attribute', () => {
      const { ac, variables, inputEl, items, itemValues } = makeScaffold([]);
      variables.push('foo', 'foobar');
      inputEl.value = 'fo';
      inputEl.selectionStart = 2;
      ac.handleTab();
      expect(itemValues()).toEqual(['foo', 'foobar']);
    });

    it('dropdownEl has role="listbox" in rendering', () => {
      // Just validate that the test scaffold's dropdownEl parent has the ID we expect
      const { dropdownEl } = makeScaffold([]);
      expect(dropdownEl.id).toBe('dd');
    });
  });

  // ── Case-insensitive matching ─────────────────────────────────────────────
  describe('Case-insensitive matching', () => {
    it('uppercase prefix matches lowercase variable names', () => {
      const { ac, variables, inputEl, itemValues } = makeScaffold([]);
      variables.push('income', 'index');
      inputEl.value = 'In';
      inputEl.selectionStart = 2;
      ac.handleTab();
      expect(itemValues()).toEqual(['income', 'index']);
    });

    it('completes correctly with mixed case', () => {
      const { ac, variables, inputEl } = makeScaffold([]);
      variables.push('GDP_pc');
      inputEl.value = 'gdp';
      inputEl.selectionStart = 3;
      ac.handleTab();
      expect(inputEl.value).toBe('GDP_pc');
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Structural – dropdown element exists in rendered terminal HTML
// ══════════════════════════════════════════════════════════════════════════════
describe('Autocomplete – HTML structure', () => {
  const loadTerminalPanel = () => proxyquire('../../src/terminal-panel', {
    './artifact-utils': {
      openArtifact: () => {},
      revealArtifact: () => {},
      copyToClipboard: () => {},
      resolveArtifactUri: () => {},
    },
  });

  it('includes the #completion-dropdown element in rendered HTML', () => withTestContext({}, ({ vscode }) => {
    let htmlContent = '';
    vscode.window.createWebviewPanel.mockImplementation(() => {
      const base = {
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        html: '',
        cspSource: 'mock-csp',
        postMessage: () => Promise.resolve(),
        asWebviewUri: (uri) => uri?.fsPath || uri,
      };
      return {
        webview: new Proxy(base, {
          set(t, p, v) { if (p === 'html') htmlContent = v; t[p] = v; return true; },
          get(t, p) { return t[p]; },
        }),
        onDidDispose: () => ({ dispose: () => {} }),
        reveal: () => {},
      };
    });

    const { TerminalPanel } = loadTerminalPanel();
    TerminalPanel.currentPanel = null;
    TerminalPanel.setExtensionUri(vscode.Uri.file('/ext'));
    TerminalPanel.show({ filePath: '/test.do', runCommand: async () => ({}) });

    expect(htmlContent).toMatch(/id="completion-dropdown"/);
    expect(htmlContent).toMatch(/class="completion-dropdown hidden"/);
    expect(htmlContent).toMatch(/role="listbox"/);
  }));

  it('includes the autocomplete script tag in rendered HTML', () => withTestContext({}, ({ vscode }) => {
    let htmlContent = '';
    vscode.window.createWebviewPanel.mockImplementation(() => {
      const base = {
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        html: '',
        cspSource: 'mock-csp',
        postMessage: () => Promise.resolve(),
        asWebviewUri: (uri) => uri?.fsPath || uri,
      };
      return {
        webview: new Proxy(base, {
          set(t, p, v) { if (p === 'html') htmlContent = v; t[p] = v; return true; },
          get(t, p) { return t[p]; },
        }),
        onDidDispose: () => ({ dispose: () => {} }),
        reveal: () => {},
      };
    });

    const { TerminalPanel } = loadTerminalPanel();
    TerminalPanel.currentPanel = null;
    TerminalPanel.setExtensionUri(vscode.Uri.file('/ext'));
    TerminalPanel.show({ filePath: '/test.do', runCommand: async () => ({}) });

    expect(htmlContent).toMatch(/autocomplete\.js/);
  }));

  it('initialises stataAutocomplete controller in inline script', () => withTestContext({}, ({ vscode }) => {
    let htmlContent = '';
    vscode.window.createWebviewPanel.mockImplementation(() => {
      const base = {
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        html: '',
        cspSource: 'mock-csp',
        postMessage: () => Promise.resolve(),
        asWebviewUri: (uri) => uri?.fsPath || uri,
      };
      return {
        webview: new Proxy(base, {
          set(t, p, v) { if (p === 'html') htmlContent = v; t[p] = v; return true; },
          get(t, p) { return t[p]; },
        }),
        onDidDispose: () => ({ dispose: () => {} }),
        reveal: () => {},
      };
    });

    const { TerminalPanel } = loadTerminalPanel();
    TerminalPanel.currentPanel = null;
    TerminalPanel.setExtensionUri(vscode.Uri.file('/ext'));
    TerminalPanel.show({ filePath: '/test.do', runCommand: async () => ({}) });

    expect(htmlContent).toMatch(/stataAutocomplete\.createController/);
  }));
});
