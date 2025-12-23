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

    convertSmclToHtml: function (smclContent) {
        const raw = (smclContent === null || smclContent === undefined) ? '' : String(smclContent);
        if (!raw) return '';

        // 1. Escape HTML first so injected tags are safe
        let html = window.stataUI.escapeHtml(raw);

        // 2. Horizontal lines {hline N} -> N dashes
        html = html.replace(/\{hline\s+(\d+)\}/g, (_, n) => {
            const len = parseInt(n, 10);
            if (!Number.isFinite(len) || len <= 0) return '';
            return '-'.repeat(Math.min(len, 500)); // cap to avoid absurd lengths
        });

        // 3. Special characters
        html = html.replace(/\{c \)-\}/g, '}');
        html = html.replace(/\{c -\(\}/g, '{');

        // 4. Font styles
        html = html.replace(/\{bf\}/g, '<b>');
        html = html.replace(/\{sf\}/g, '</b>');
        html = html.replace(/\{it\}/g, '<i>');

        // 5. Color/mode switches
        html = html.replace(/\{err\}/g, '</span><span class="err">');
        html = html.replace(/\{res\}/g, '</span><span class="res">');
        html = html.replace(/\{txt\}/g, '</span><span class="txt">');

        // 6. Search links {search ...}
        html = html.replace(/\{search\s+([^}]+)\}/g, (_match, content) => {
            const displayText = content.split(',')[0];
            const safeDisplay = window.stataUI.escapeHtml(displayText);
            const query = encodeURIComponent(displayText || '');
            return `<a href="https://www.google.com/search?q=stata+${query}" target="_blank" rel="noreferrer">${safeDisplay}</a>`;
        });

        // 7. Strip any unknown tags
        html = html.replace(/\{.*?\}/g, '');

        // 8. Wrap in initial span to satisfy closing/opening swaps above
        return `<span class="smcl txt">${html}</span>`;
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
    }
};
