/**
 * Utility for filtering out mcp-stata internal log markers and management commands.
 * Centralized here to ensure DRY (Don't Repeat Yourself) consistency across the extension.
 */

const INTERNAL_PATTERNS = [
    // Internal log/return management commands (even if prefixed with . or {com})
    /capture\s+log\s+close\s+_mcp_smcl_/i,
    /capture\s+_return\s+hold\s+mcp_hold_/i,

    // Log header metadata (tolerant of SMCL tags like {txt}, {res} and leading whitespace)
    /^\s*(\{smcl\})?\s*$/i,
    /(\s*\{[^}]+\})*\s*log\s+type:\s+.*smcl/i,
    /(\s*\{[^}]+\})*\s*opened\s+on:\s+/i,
    /(\s*\{[^}]+\})*\s*log:\s+.*(mcp_smcl_|<unnamed>)/i,
    /(\s*\{[^}]+\})*\s*name:\s+.*(_mcp_smcl_|<unnamed>)/i,
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

/**
 * Basic SMCL parser to extract return codes and error context.
 * Useful for summarizing results and highlighting errors.
 * @param {string} smclText Raw SMCL string
 * @returns {{rc: number|null, errorContext: string|null}}
 */
function parseSMCL(smclText) {
    if (!smclText) return { rc: null, errorContext: null };

    // Regexes for SMCL tags.
    // We use a broader match without the ^ anchor to handle indentation in do-files.
    const errRegex = /{err}(.*?)(?={txt}|{res}|{com}|$)/gs;

    let rc = null;
    let errorContext = null;

    // 1. Look for return codes r(N);
    const rcRegex = /r\((\d+)\);/g;
    let match;
    while ((match = rcRegex.exec(smclText)) !== null) {
        rc = parseInt(match[1]);
    }

    // 2. Extract error context from {err} blocks
    const errMatches = [];
    let errMatch;
    while ((errMatch = errRegex.exec(smclText)) !== null) {
        const content = errMatch[1].trim();
        if (content && !content.includes('capture log close')) {
            errMatches.push(content);
        }
    }

    if (errMatches.length > 0) {
        // Prepend "Error: " if not already there, for better visibility in UI
        errorContext = errMatches.map(e => e.toLowerCase().startsWith('error') ? e : `Error: ${e}`).join('\n');
    }

    return { rc, errorContext };
}

module.exports = {
    filterMcpLogs,
    parseSMCL,
    INTERNAL_PATTERNS
};
