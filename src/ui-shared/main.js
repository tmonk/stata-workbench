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
        if (!window.hljs) return;

        const elements = root.querySelectorAll('.syntax-highlight:not(.highlighted)');
        elements.forEach(el => {
            try {
                let raw = el.textContent;
                let prefix = '';

                // Handling for standard Stata prompt ". "
                if (raw.startsWith('. ')) {
                    prefix = '. ';
                    raw = raw.substring(2);
                }

                // FIX: If element contains HTML structure (like smcl-hline), DO NOT highlight
                // This preserves horizontal lines and other rich content that shouldn't be parsed as code
                if (el.children.length > 0) {
                    el.classList.add('highlighted');
                    // We might want to bold the prompt if it exists, but for now just leave it alone
                    // to avoid breaking the complex structure
                    return;
                }

                // FIX: If only prompt remains, do not highlight as Stata code
                if (!raw.trim()) {
                    const escapedPrefix = window.stataUI.escapeHtml(prefix);
                    el.innerHTML = '<span class="prompt">' + escapedPrefix + '</span>';
                    el.classList.add('highlighted');
                    // Do NOT add 'hljs' class to avoid background/color changes for non-code
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
