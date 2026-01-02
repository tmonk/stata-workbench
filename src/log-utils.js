/**
 * Utility for filtering out mcp-stata internal log markers and management commands.
 * Centralized here to ensure DRY (Don't Repeat Yourself) consistency across the extension.
 */

const INTERNAL_PATTERNS = [
    // Internal log/return management commands (even if prefixed with . or {com})
    /capture\s+log\s+close\s+_mcp_smcl_/i,
    /capture\s+_return\s+hold\s+mcp_hold_/i,

    // Log header metadata (tolerant of SMCL tags like {txt}, {res})
    /log\s+type:\s+.*smcl/i,
    /opened\s+on:\s+/i,
    /log:\s+.*mcp_smcl_/i,
    /name:\s+.*_mcp_smcl_/i,
    /\{txt\}\{sf\}\{ul off\}\{\.-\}/i
];

/**
 * Filter out mcp-stata internal lines from a block of text.
 * @param {string} text Raw SMCL or plain text from Stata
 * @returns {string} Filtered text with internal markers removed
 */
function filterMcpLogs(text) {
    if (!text) return '';

    const lines = text.split(/\r?\n/);
    const filtered = lines.filter(line => {
        const trimmed = line.trim();
        if (!trimmed) return true;

        for (const pattern of INTERNAL_PATTERNS) {
            if (pattern.test(line)) return false;
        }
        return true;
    });

    return filtered.join('\n');
}

module.exports = {
    filterMcpLogs,
    INTERNAL_PATTERNS
};
