// Shared UI Logic for Stata Extension

window.stataUI = {
    escapeHtml: function (text) {
        return (text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    },

    formatDuration: function (ms) {
        if (ms === null || ms === undefined) return '';
        if (ms < 1000) return ms + ' ms';
        const s = ms / 1000;
        if (s < 60) return s.toFixed(1) + ' s';
        const m = Math.floor(s / 60);
        const rem = s - m * 60;
        return `${m}m ${rem.toFixed(0)}s`;
    },

    formatTimestamp: function (ts) {
        const d = new Date(ts);
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleString(undefined, { hour: 'numeric', minute: 'numeric', second: 'numeric' });
    },

    // Common setup for artifact buttons
    bindArtifactEvents: function (vscode) {
        document.addEventListener('click', (e) => {
            const target = e.target.closest('[data-action="open-artifact"]');
            if (target) {
                const path = target.getAttribute('data-path');
                const baseDir = target.getAttribute('data-basedir');
                const label = target.getAttribute('data-label');
                if (path) {
                    vscode.postMessage({
                        type: 'openArtifact', // unified message type
                        path,
                        baseDir,
                        label
                    });
                }
            }
        });
    },

    // StataHighlighter removed in favor of highlight.js

    processSyntaxHighlighting: function (root = document) {
        if (!window.hljs) {
            console.error('[Terminal] Highlight.js not found');
            return;
        }

        // Ensure Stata language is registered
        if (!window.hljs.getLanguage('stata')) {
            console.log('[Terminal] Registering basic Stata language support');
            window.hljs.registerLanguage('stata', function (hljs) {
                return {
                    name: 'stata',
                    aliases: ['do', 'ado'],
                    keywords: {
                        keyword: 'use sysuse clear save append merge collapse by sort g gen generate replace ' +
                            'reg regress su summarize tab tabulate list count drop keep if in ' +
                            'cap capture qui quietly noi noisily ' +
                            'loc local glob global tempvar tempname tempfile ' +
                            'foreach forvalues while if else continue break'
                    },
                    contains: [
                        hljs.HASH_COMMENT_MODE,
                        hljs.C_BLOCK_COMMENT_MODE,
                        { className: 'comment', begin: '^\\*.*$', end: '$' },
                        { className: 'string', begin: '"', end: '"', illegal: '\\n' },
                        { className: 'string', begin: '`"', end: '"\'', contains: [hljs.BACKSLASH_ESCAPE] },
                        { className: 'variable', begin: '`', end: '\'' },
                        { className: 'variable', begin: '\\$', end: '[a-zA-Z_0-9]*' }
                    ]
                };
            });
        }

        const elements = root.querySelectorAll('.syntax-highlight:not(.highlighted)');
        if (elements.length > 0) {
            console.log('[Terminal] Highlighting ' + elements.length + ' elements');
        }

        elements.forEach(el => {
            try {
                let raw = el.textContent;
                let prefix = '';

                // Handling for standard Stata prompt "." or ". "
                if (raw.startsWith('. ')) {
                    prefix = '. ';
                    raw = raw.substring(2);
                } else if (raw === '.' || raw.startsWith('.')) {
                    prefix = '.';
                    raw = raw.substring(1);
                }

                // FIX: If element contains HTML structure (like smcl-hline), DO NOT highlight
                if (el.children.length > 0) {
                    el.classList.add('highlighted');
                    return;
                }

                // FIX: If only prompt remains, do not highlight as Stata code
                if (!raw.trim()) {
                    const escapedPrefix = window.stataUI.escapeHtml(prefix);
                    el.innerHTML = '<span class="prompt">' + escapedPrefix + '</span>';
                    el.classList.add('highlighted');
                    return;
                }

                // Explicitly use 'stata' language
                const result = window.hljs.highlight(raw, { language: 'stata' });

                // Reassemble: prompt (escaped) + highlighted code
                const escapedPrefix = window.stataUI.escapeHtml(prefix);

                // Use simple concatenation to avoid backtick issues
                el.innerHTML = '<span class="prompt">' + escapedPrefix + '</span>' + result.value;
                el.classList.add('highlighted');
                el.classList.add('hljs'); // Add hljs class for styling matches
            } catch (err) {
                console.error('[Terminal] Highlight error:', err);
                el.classList.add('highlighted'); // prevent infinite retries
            }
        });
    }
};

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.stataUI;
}
