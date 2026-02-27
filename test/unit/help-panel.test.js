/**
 * Tests for HelpPanel markdown rendering.
 *
 * Verifies that well-structured Markdown from smcl_to_markdown is rendered
 * faithfully into HTML — headings, tables, code blocks, inline formatting.
 */
const { describe, it, expect, beforeEach } = require('bun:test');
const proxyquire = require('proxyquire').noCallThru().noPreserveCache();

// Load help-panel with mocked vscode (no webview instantiation needed)
const loadHelpPanel = () => {
    const { HelpPanel } = proxyquire('../../src/help-panel', {
        'fs': {},
        '@sentry/node': { captureException: () => {} }
    });
    return HelpPanel;
};

// Helper: instantiate a bare HelpPanel so we can call _renderMarkdown
function makePanel() {
    const HelpPanel = loadHelpPanel();
    // Construct without actually creating a vscode webview panel
    const obj = Object.create(HelpPanel.prototype);
    return obj;
}

describe('HelpPanel._renderMarkdown', () => {
    let panel;
    beforeEach(() => { panel = makePanel(); });

    // ── Headings ───────────────────────────────────────────────────────────
    it('renders h1 from # heading', () => {
        const html = panel._renderMarkdown('# Help for regress');
        expect(html).toContain('<h1>Help for regress</h1>');
    });

    it('renders h2 from ## heading', () => {
        const html = panel._renderMarkdown('## Syntax');
        expect(html).toContain('<h2>Syntax</h2>');
    });

    it('renders h3 from ### heading', () => {
        const html = panel._renderMarkdown('### Model');
        expect(html).toContain('<h3>Model</h3>');
    });

    // ── Inline formatting ──────────────────────────────────────────────────
    it('renders bold from **text**', () => {
        const html = panel._renderMarkdown('`regress` performs **ordinary** least-squares.');
        expect(html).toContain('<strong>ordinary</strong>');
    });

    it('renders italic from *text*', () => {
        const html = panel._renderMarkdown('See *depvar* for details.');
        expect(html).toContain('<em>depvar</em>');
    });

    it('renders inline code from `text`', () => {
        const html = panel._renderMarkdown('Use `regress mpg weight`.');
        expect(html).toContain('<code>regress mpg weight</code>');
    });

    it('renders link from [label](url)', () => {
        const html = panel._renderMarkdown('[Example](https://example.com)');
        expect(html).toContain('<a href="https://example.com">Example</a>');
    });

    it('escapes HTML entities in plain text', () => {
        const html = panel._renderMarkdown('Use a < b & c > d');
        expect(html).toContain('&lt;');
        expect(html).toContain('&amp;');
        expect(html).toContain('&gt;');
    });

    // ── Code blocks ────────────────────────────────────────────────────────
    it('renders stata code block as <pre><code>', () => {
        const md = '```stata\n. regress mpg weight foreign\n```';
        const html = panel._renderMarkdown(md);
        expect(html).toContain('<pre><code>');
        expect(html).toContain('regress mpg weight foreign');
        expect(html).toContain('</code></pre>');
    });

    it('does not double-escape code in code blocks', () => {
        const md = '```stata\n. gen x = a < b\n```';
        const html = panel._renderMarkdown(md);
        // The code block content should have HTML-escaped < but not processed as markup
        expect(html).toContain('&lt;');
        expect(html).not.toContain('<b>');
    });

    it('renders multiple code blocks independently', () => {
        const md = [
            '```stata', '. sysuse auto', '```',
            '',
            '```stata', '. regress mpg weight', '```'
        ].join('\n');
        const html = panel._renderMarkdown(md);
        expect(html.match(/<pre>/g)).toHaveLength(2);
        expect(html).toContain('sysuse auto');
        expect(html).toContain('regress mpg weight');
    });

    // ── Tables ─────────────────────────────────────────────────────────────
    it('renders a Markdown table as HTML table', () => {
        const md = [
            '| Option | Description |',
            '|--------|-------------|',
            '| `noconstant` | suppress constant term |',
            '| `beta` | standardized coefficients |',
        ].join('\n');
        const html = panel._renderMarkdown(md);
        expect(html).toContain('<table>');
        expect(html).toContain('<th>');
        expect(html).toContain('<td>');
        expect(html).toContain('</table>');
        expect(html).toContain('suppress constant term');
        expect(html).toContain('standardized coefficients');
    });

    it('renders table header row with <th>', () => {
        const md = [
            '| Option | Description |',
            '|--------|-------------|',
            '| `x` | something |',
        ].join('\n');
        const html = panel._renderMarkdown(md);
        expect(html).toContain('<th>Option</th>');
        expect(html).toContain('<th>Description</th>');
    });

    it('renders inline code inside table cells', () => {
        const md = [
            '| Option | Description |',
            '|--------|-------------|',
            '| `level(#)` | set confidence level; default is `level(95)` |',
        ].join('\n');
        const html = panel._renderMarkdown(md);
        expect(html).toContain('<code>level(#)</code>');
        expect(html).toContain('<code>level(95)</code>');
    });

    it('renders bold section name inside table', () => {
        const md = [
            '| Option | Description |',
            '|--------|-------------|',
            '| `beta` | report **standardized** beta |',
        ].join('\n');
        const html = panel._renderMarkdown(md);
        expect(html).toContain('<strong>standardized</strong>');
    });

    // ── Horizontal rule ────────────────────────────────────────────────────
    it('renders horizontal rule from ---', () => {
        const html = panel._renderMarkdown('---');
        expect(html).toContain('<hr>');
    });

    // ── Full realistic help output ─────────────────────────────────────────
    it('renders a realistic help document with all element types', () => {
        const md = [
            '# Help for regress',
            '',
            '## Syntax',
            '',
            '### Model',
            '',
            '| Option | Description |',
            '|--------|-------------|',
            '| `noconstant` | suppress constant term |',
            '',
            '## Description',
            '',
            '`regress` performs **ordinary least-squares** linear regression.',
            '',
            '## Examples',
            '',
            '```stata',
            '. sysuse auto',
            '. regress mpg weight foreign',
            '```',
            '',
            '## Stored results',
            '',
            '**Scalars**',
            '',
            '| Name | Description |',
            '|------|-------------|',
            '| `e(N)` | number of observations |',
        ].join('\n');

        const html = panel._renderMarkdown(md);
        expect(html).toContain('<h1>Help for regress</h1>');
        expect(html).toContain('<h2>Syntax</h2>');
        expect(html).toContain('<h3>Model</h3>');
        expect(html).toContain('<h2>Description</h2>');
        expect(html).toContain('<h2>Examples</h2>');
        expect(html).toContain('<pre><code>');
        expect(html).toContain('sysuse auto');
        expect(html).toContain('<table>');
        expect(html).toContain('<code>e(N)</code>');
        expect(html).not.toContain('{');
    });
});
