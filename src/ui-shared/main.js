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
    }
};
