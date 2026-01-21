// Shared UI Logic for Stata Extension

const Sentry = typeof require !== 'undefined' ? require("@sentry/browser") : null;

if (Sentry && Sentry.init) {
    Sentry.init({
        dsn: "https://97f5f46047e65ebbf758c0e9e4ffe6c5@o4510744386732032.ingest.de.sentry.io/4510744389550160",
        release: process.env.SENTRY_RELEASE,
        integrations: [
            Sentry.replayIntegration({
                maskAllText: true,
                blockAllMedia: true,
            }),
        ],
        // Session Replay
        replaysSessionSampleRate: 0.1,
        replaysOnErrorSampleRate: 1.0,
        tracePropagationTargets: ["localhost", /^\//, /^\/api\//],
    });
}

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

    filterMcpLogs: function (text) {
        if (!text) return '';
        const INTERNAL_PATTERNS = [
            /capture\s+log\s+close\s+_mcp_smcl_/i,
            /capture\s+_return\s+hold\s+mcp_hold_/i,
            /^\s*(\{smcl\})?\s*$/i,
            /(\s*\{[^}]+\})*\s*log\s+type:\s+.*smcl/i,
            /(\s*\{[^}]+\})*\s*opened\s+on:\s+/i,
            /(\s*\{[^}]+\})*\s*log:\s+.*(mcp_smcl_|<unnamed>)/i,
            /(\s*\{[^}]+\})*\s*name:\s+.*(_mcp_smcl_|<unnamed>)/i,
            /\{txt\}\{sf\}\{ul off\}\{\.-\}/i
        ];
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
    },

    smclToHtml: function (text) {
        if (!text) return '';

        // 0. Filter out mcp-stata internal lines
        const filteredText = window.stataUI.filterMcpLogs(text);

        // Normalize newlines early
        let normalized = filteredText.replace(/\r\n/g, '\n');

        // Collapse prompt-only lines
        normalized = normalized.replace(/^(\. ?)\n/gm, '$1');

        let lines = normalized.split('\n');
        lines = lines.map(line => {
            if (line.trim().startsWith('.') && !line.includes('<span') && !line.includes('{com}')) {
                return `{com}${line}{/com}`;
            }
            return line;
        });
        let processedText = lines.join('\n');

        // Remove global SMCL wrappers
        let html = processedText.replace(/\{smcl\}|\{\/smcl\}/gi, '');

        // 1. Basic entity cleaning - we ONLY escape specific SMCL constants here.
        // Generic content escaping moved to the token loop for correctness.
        html = html
            .replace(/\{c -\}/g, '-')
            .replace(/\{c \|\}/g, '|')
            .replace(/\{c \+\}/g, '+')
            .replace(/\{c B\+\}/g, '+')
            .replace(/\{c \+T\}/g, '+')
            .replace(/\{c T\+\}/g, '+')
            .replace(/\{c TT\}/g, '+')
            .replace(/\{c BT\}/g, '+')
            .replace(/\{c TR\}/g, '+')
            .replace(/\{c TL\}/g, '+')
            .replace(/\{c BR\}/g, '+')
            .replace(/\{c BL\}/g, '+')
            .replace(/\{c -(?:-)*\}/g, (m) => '-'.repeat(m.length - 4))
            .replace(/\{c \+(?:\+)*\}/g, (m) => '+'.repeat(m.length - 4));

        html = html.replace(/\{c -\(\}/g, '__BRACE_OPEN__').replace(/\{c \)-\}/g, '__BRACE_CLOSE__');

        const tokenRegex = /(\{(?:[^{}]|\{[^{}]*\})*\})|(\n)|([^{}\n]+)|(.)/g;
        let match;
        let result = '';
        let currentLineLen = 0;
        let wasNewline = false;
        const MODE_TAGS = ['com', 'res', 'err', 'txt', 'input', 'result', 'text', 'error', 'bf', 'it', 'sf', 'ul', 'hi', 'hilite', 'bold', 'italic', 'inp', 'result', 'err', 'txt'];
        const openTags = [];
        const PARAGRAPH_SHORTCUTS = {
            pstd: [4, 4, 2],
            psee: [4, 13, 2],
            phang: [4, 8, 2],
            pmore: [8, 8, 2],
            pin: [8, 8, 2],
            phang2: [8, 12, 2],
            pmore2: [12, 12, 2],
            pin2: [12, 12, 2],
            phang3: [12, 16, 2],
            pmore3: [16, 16, 2],
            pin3: [16, 16, 2]
        };

        // Track table settings
        let tableSettings = {
            p2col: [0, 0, 0, 0], // indent1, col2, indent2, marginR
            synopt: 20
        };

        while ((match = tokenRegex.exec(html)) !== null) {
            const tag = match[1];
            const newline = match[2];
            const textContent = match[3] || match[4];

            if (newline) {
                if (wasNewline) {
                    while (openTags.length > 0) {
                        const top = openTags.pop();
                        if (top === 'DIV' || top === 'DIV_ROW') {
                            result += '</div>';
                        } else {
                            result += '</span>';
                        }
                    }
                }
                // If we just ended a block (DIV/DIV_ROW), this newline might be redundant
                // but for pre-wrap consistency we usually want it. 
                // However, the user is seeing double spacing.
                result += '\n';
                currentLineLen = 0;
                wasNewline = true;
                continue;
            }

            if (textContent) {
                if (textContent.trim().length > 0) {
                    wasNewline = false;
                }
                // Escape HTML entities in raw text content
                result += textContent
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');
                currentLineLen += textContent.length;
                continue;
            }

            if (tag) {
                wasNewline = false;
                const inner = tag.substring(1, tag.length - 1);
                let tagName = inner;
                let tagContent = null;
                const firstColon = inner.indexOf(':');

                if (firstColon !== -1) {
                    const cmdCandidate = inner.substring(0, firstColon).split(/\s+/)[0].toLowerCase();
                    if (!['col', 'column', 'space', 'hline', '.-'].includes(cmdCandidate)) {
                        tagName = inner.substring(0, firstColon);
                        tagContent = inner.substring(firstColon + 1);
                    }
                }

                const parts = tagName.split(/\s+/);
                const command = parts[0].toLowerCase();

                if (command === 'col' || command === 'column') {
                    const dest = parseInt(parts[1], 10);
                    if (!isNaN(dest)) {
                        let spacesNeeded = (dest - 1) - currentLineLen;
                        if (spacesNeeded > 0) {
                            const spacer = ' '.repeat(spacesNeeded);
                            result += spacer;
                            currentLineLen += spacesNeeded;
                        }
                    }
                    continue;
                }

                if (command === 'space') {
                    const amt = parts[1] ? parseInt(parts[1], 10) : 1;
                    if (!isNaN(amt)) {
                        const spacer = ' '.repeat(amt);
                        result += spacer;
                        currentLineLen += amt;
                    }
                    continue;
                }

                if (command.startsWith('hline')) {
                    if (parts[1] && !isNaN(parseInt(parts[1]))) {
                        let len = parseInt(parts[1], 10);
                        result += '-'.repeat(len);
                        currentLineLen += len;
                    } else {
                        result += '-'.repeat(60); 
                        currentLineLen += 60;
                    }
                    continue;
                }

                if (command === '.-') {
                    result += '-';
                    currentLineLen += 1;
                    continue;
                }

                if (PARAGRAPH_SHORTCUTS[command] || command === 'p') {
                    const settings = PARAGRAPH_SHORTCUTS[command] || parts.slice(1).map(n => parseInt(n, 10)).filter(n => !isNaN(n));
                    const i1 = settings[0] || 0;
                    const i2 = settings[1] || 0;
                    const i3 = settings[2] || 0;
                    
                    if (result.length > 0 && !result.endsWith('\n')) result += '\n';
                    // Reduced margin-bottom to 0 for tighter table rows.
                    // We must use white-space: pre-wrap to preserve multiple spaces and ensure ch unit alignment.
                    // Also use min-width to ensure the div doesn't collapse excessively.
                    result += `<div style="padding-left:${i2}ch; text-indent:${i1 - i2}ch; padding-right:${i3}ch; margin-bottom:0px; white-space:pre-wrap; min-width: max-content;">`;
                    openTags.push('DIV');
                    currentLineLen = 0;
                    continue;
                }

                if (command === 'p_end') {
                    while (openTags.length > 0) {
                        const top = openTags.pop();
                        if (top === 'DIV' || top === 'DIV_ROW') {
                            result += '</div>';
                            if (top === 'DIV_ROW') result += '</div>';
                            break;
                        }
                        result += '</span>';
                    }
                    // Removed extra newline addition here to prevent double-spacing in tables
                    currentLineLen = 0;
                    continue;
                }

                if (command === 'p2colset' || command === 'synoptset') {
                    const nums = parts.slice(1).map(n => parseInt(n, 10)).filter(n => !isNaN(n));
                    if (nums.length >= 4) tableSettings.p2col = nums;
                    continue;
                }

                if (command === 'p2col' || command === 'synopt' || command === 'p2coldent') {
                    let settings = tableSettings.p2col;
                    const nums = parts.slice(1).map(n => parseInt(n, 10)).filter(n => !isNaN(n));
                    if (nums.length >= 4) settings = nums;

                    const i1 = settings[0] || 0;
                    const c2 = settings[1] || 15;
                    const i2 = settings[2] || c2 + 2;
                    const mr = settings[3] || 2;

                    if (openTags.includes('DIV_ROW')) {
                        while (openTags.length > 0) {
                            const top = openTags.pop();
                            if (top === 'DIV_ROW') { result += '</div></div>'; break; }
                            result += '</span>';
                        }
                    }

                    result += `<div style="display:flex; flex-direction:row; padding-left:${i1}ch; padding-right:${mr}ch; margin-bottom:0px; white-space:pre;">`;
                    result += `<div style="flex: 0 0 ${c2 - i1}ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-right:2ch;">`;
                    if (tagContent) {
                        let contentToRender = tagContent;
                        // Strip leading colon if present in p2col/synopt/p2coldent
                        if (contentToRender.startsWith(':')) {
                            contentToRender = contentToRender.substring(1);
                        }
                        result += window.stataUI.smclToHtml(contentToRender);
                    }
                    result += `</div>`;
                    result += `<div style="flex:1; padding-left:${Math.max(0, i2 - c2)}ch; white-space:pre-wrap;">`;
                    openTags.push('DIV_ROW'); 
                    currentLineLen = 0;
                    continue;
                }

                if (command === 'p2colreset') {
                    tableSettings.p2col = [0, 0, 0, 0];
                    continue;
                }

                if (command === 'marker') {
                    const arg = tagName.substring(command.length).trim();
                    result += `<a name="${window.stataUI.escapeHtml(arg)}"></a>`;
                    continue;
                }

                if (command === 'dup') {
                    const count = parseInt(parts[1], 10);
                    if (!isNaN(count) && tagContent !== null) {
                        const content = window.stataUI.smclToHtml(tagContent);
                        result += content.repeat(Math.max(0, count));
                        let visibleText = content.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
                        currentLineLen += visibleText.length * count;
                    }
                    continue;
                }

                if (command === 'c' || command === 'char') {
                    const arg = parts[1];
                    if (arg) {
                        try {
                            let char;
                            if (arg.startsWith('0x')) {
                                char = String.fromCharCode(parseInt(arg.substring(2), 16));
                            } else if (!isNaN(parseInt(arg, 10))) {
                                char = String.fromCharCode(parseInt(arg, 10));
                            }
                            if (char) {
                                result += window.stataUI.escapeHtml(char);
                                currentLineLen += 1;
                            }
                        } catch (e) {}
                    }
                    continue;
                }

                if (command === 'ralign' || command === 'lalign' || command === 'center') {
                    if (tagContent !== null) {
                        let width = parseInt(parts[1], 10);
                        let innerHtml = window.stataUI.smclToHtml(tagContent);
                        if (!isNaN(width)) {
                            let visibleText = innerHtml.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
                            let len = visibleText.length;
                            let padding = Math.max(0, width - len);
                            if (padding > 0) {
                                let leftPad = 0, rightPad = 0;
                                if (command === 'ralign') leftPad = padding;
                                else if (command === 'lalign') rightPad = padding;
                                else if (command === 'center') { leftPad = Math.floor(padding / 2); rightPad = padding - leftPad; }
                                if (leftPad) { result += ' '.repeat(leftPad); currentLineLen += leftPad; }
                                result += innerHtml;
                                currentLineLen += len;
                                if (rightPad) { result += ' '.repeat(rightPad); currentLineLen += rightPad; }
                                continue;
                            }
                        }
                        result += innerHtml;
                        let visibleText = innerHtml.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
                        currentLineLen += visibleText.length;
                        continue;
                    }
                }

                if (MODE_TAGS.includes(command) || command === '/' + openTags[openTags.length - 1]) {
                    if (tagContent !== null && MODE_TAGS.includes(command)) {
                        result += window.stataUI._startTag(command);
                        let innerC = window.stataUI.smclToHtml(tagContent);
                        result += innerC;
                        result += '</span>';
                        let visibleText = innerC.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
                        currentLineLen += visibleText.length;
                        continue;
                    }

                    if (openTags.length > 0) {
                        const current = openTags[openTags.length - 1];
                        // Only auto-close if the current top tag is also a mode tag
                        if (MODE_TAGS.includes(command) && MODE_TAGS.includes(current)) {
                            result += `</span>`;
                            openTags.pop();
                        } else if (command === '/' + current) {
                            if (current === 'DIV' || current === 'DIV_ROW') {
                                result += '</div>';
                            } else {
                                result += '</span>';
                            }
                            openTags.pop();
                            continue;
                        }
                    }

                    if (MODE_TAGS.includes(command)) {
                        result += window.stataUI._startTag(command);
                        openTags.push(command);
                    }
                    continue;
                }

                if (command === 'bind') {
                    if (tagContent !== null) {
                        // Use white-space: pre to guarantee that multiple spaces inside bind are NOT collapsed.
                        result += `<span style="white-space:pre;">` + window.stataUI.smclToHtml(tagContent) + `</span>`;
                        let visibleInner = tagContent.replace(/\{[^}]+\}/g, '');
                        currentLineLen += visibleInner.length;
                    }
                    continue;
                }

                if (command === 'browse' || command === 'view' || command === 'help' || command === 'stata' || command === 'helpb' || command === 'helpi' || command === 'net' || command === 'ado' || command === 'update') {
                    const arg = tagName.substring(command.length).trim();
                    const content = tagContent !== null ? window.stataUI.smclToHtml(tagContent) : arg;
                    let extraClass = (command === 'helpb' || command === 'helpi') ? (command === 'helpb' ? ' smcl-bf' : ' smcl-it') : '';
                    result += `<span class="smcl-link${extraClass}" data-type="${command}" data-arg="${arg}">${content}</span>`;
                    let visibleText = content.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
                    currentLineLen += visibleText.length;
                    continue;
                }

                if (tagContent !== null) {
                    result += window.stataUI.smclToHtml(tagContent);
                    let visibleText = tagContent.replace(/\{[^}]+\}/g, '');
                    currentLineLen += visibleText.length;
                    continue;
                }
            }
        }

        while (openTags.length > 0) {
            const top = openTags.pop();
            if (top === 'DIV' || top === 'DIV_ROW') {
                result += '</div>';
                if (top === 'DIV_ROW') result += '</div>';
            } else {
                result += '</span>';
            }
        }

        result = result.replace(/__BRACE_OPEN__/g, '{').replace(/__BRACE_CLOSE__/g, '}');

        if (!result.includes('smcl-com')) {
            if (result.trim().startsWith('.') && !result.includes('smcl-')) {
                result = `<span class="smcl-com syntax-highlight">${result}</span>`;
            }
        }
        return result;
    },

    _startTag: function (tagName) {
        const meta = window.stataUI._getTagMeta(tagName);
        let className = meta.class ? ` class="${meta.class}"` : '';
        if (tagName === 'com') {
            className = ' class="smcl-com syntax-highlight"';
        }
        const dataAttrs = meta.data ? ` ${meta.data}` : '';
        return `<span${className}${dataAttrs}>`;
    },

    _getTagMeta: function (tagName) {
        const tag = tagName.toLowerCase().split(/\s+/)[0];
        switch (tag) {
            case 'res': case 'result': return { class: 'smcl-res' };
            case 'txt': case 'text': return { class: 'smcl-txt' };
            case 'err': case 'error': return { class: 'smcl-err' };
            case 'com': case 'input': case 'inp': return { class: 'smcl-com' };
            case 'bf': case 'bold': return { class: 'smcl-bf' };
            case 'it': case 'italic': return { class: 'smcl-it' };
            case 'sf': return { class: 'smcl-sf' };
            case 'ul': return { class: 'smcl-ul' };
            case 'hi': case 'hilite': return { class: 'smcl-hi' };
            case 'stata': return { class: 'smcl-link', data: 'data-type="stata"' };
            case 'help': case 'helpb': case 'helpi': return { class: 'smcl-link', data: 'data-type="help"' };
            case 'browse': return { class: 'smcl-link', data: 'data-type="browse"' };
            case 'view': return { class: 'smcl-link', data: 'data-type="view"' };
            default: return { class: '' };
        }
    },

    parseSMCL: function (smclText) {
        if (!smclText) return { rc: null, formattedText: '' };
        const lines = smclText.split('\n');
        let extractedRC = null;
        let callStack = [];
        let commandHistory = [];
        let errorMessages = [];
        let errorLineIndex = -1;
        let hasError = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;
            if (!extractedRC) {
                const searchMatch = line.match(/\{search r\((\d+)\)/i);
                if (searchMatch) {
                    extractedRC = parseInt(searchMatch[1], 10);
                } else {
                    const standaloneRC = trimmedLine.match(/^r\((\d+)\);$/);
                    if (standaloneRC) {
                        extractedRC = parseInt(standaloneRC[1], 10);
                    }
                }
            }
            const errMatch = line.match(/^\{err\}(.+)$/);
            if (errMatch) {
                hasError = true;
                const errorText = errMatch[1].trim().replace(/\{[^}]+\}/g, '');
                if (errorText) {
                    errorMessages.push(errorText);
                    if (errorLineIndex === -1) errorLineIndex = i;
                }
            }
            const beginMatch = line.match(/begin\s+(\S+)/);
            if (beginMatch) {
                const funcName = beginMatch[1];
                if (errorLineIndex === -1 || i < errorLineIndex) callStack.push(funcName);
            }
            const endMatch = line.match(/end\s+(\S+)/);
            if (endMatch && callStack.length > 0) {
                if (errorLineIndex === -1 || i < errorLineIndex) {
                    const funcName = endMatch[1];
                    if (callStack[callStack.length - 1] === funcName) callStack.pop();
                }
            }
            if (trimmedLine.startsWith('= ')) {
                let cmd = trimmedLine.substring(2).trim();
                cmd = cmd.replace(/^((cap(ture)?|qui(etly)?|noi(sily)?)\s+)+/gi, '').trim();
                const isUtilityCmd = /^(loc(al)?|if|else|args|return|exit|scalar|matrix|global|tempvar|tempname|tempfile|macro|while|foreach|forvalues|continue|Cleanup|Drop|Clear)\b/i.test(cmd);
                if (!isUtilityCmd && cmd.length > 0 && (errorLineIndex === -1 || i < errorLineIndex)) {
                    commandHistory.push(cmd);
                    if (commandHistory.length > 3) commandHistory.shift();
                }
            } else {
                const comMatch = line.match(/^\{com\}(.+)$/);
                if (comMatch) {
                    let cmd = comMatch[1].trim().replace(/\{[^}]+\}/g, '');
                    if (cmd.startsWith('. ')) cmd = cmd.substring(2).trim();
                    cmd = cmd.replace(/^((cap(ture)?|qui(etly)?|noi(sily)?)\s+)+/gi, '').trim();
                    const isUtilityCmd = /^(loc(al)?|if|else|args|\.|\*|while|foreach|forvalues|continue|Cleanup|Drop|Clear)\b/i.test(cmd);
                    if (!isUtilityCmd && cmd.length > 0 && (errorLineIndex === -1 || i < errorLineIndex)) {
                        commandHistory.push(cmd);
                        if (commandHistory.length > 3) commandHistory.shift();
                    }
                }
            }
        }
        if (errorMessages.length === 0) return { rc: extractedRC, formattedText: '', hasError: hasError };
        let filteredErrors = errorMessages.filter(e => e.length > 0);
        if (filteredErrors.length > 1) {
            const hasSpecificError = filteredErrors.some(e => !e.match(/^error \d+$/i));
            if (hasSpecificError) filteredErrors = filteredErrors.filter(e => !e.match(/^error \d+$/i));
        }
        const uniqueErrors = [...new Set(filteredErrors)];
        let parts = [];
        if (callStack.length > 0) parts.push(`In: ${callStack.join(' → ')}`);
        if (commandHistory.length > 0) {
            const cmd = commandHistory[commandHistory.length - 1];
            const formattedCmd = cmd.replace(/,\s+/g, ',\n    ').replace(/\s+(if|in|using)\s+/gi, '\n    $1 ').trim();
            parts.push(`\nCommand:\n  ${formattedCmd}`);
        }
        if (uniqueErrors.length > 0) parts.push(`\nError: ${uniqueErrors.join('\n       ')}`);
        return { rc: extractedRC, formattedText: parts.join('\n').trim(), hasError: hasError };
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
        const start = Date.now();
        let totalChars = 0;
        elements.forEach(el => {
            totalChars += (el.textContent || '').length;
        });
        console.log('[Highlight] elements=' + elements.length + ' chars=' + totalChars);

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
        const totalNow = root.querySelectorAll('.syntax-highlight').length;
        const highlightedNow = root.querySelectorAll('.syntax-highlight.highlighted').length;
        const sampleEl = root.querySelector('.syntax-highlight.highlighted');
        const sampleColor = sampleEl ? window.getComputedStyle(sampleEl).color : null;
        const sampleBg = sampleEl ? window.getComputedStyle(sampleEl).backgroundColor : null;
        const sampleString = root.querySelector('.hljs-string');
        const stringColor = sampleString ? window.getComputedStyle(sampleString).color : null;
        console.log('[Highlight] style sample color=' + sampleColor + ' bg=' + sampleBg);
        const elapsed = Date.now() - start;
        console.log('[Highlight] elements=' + elements.length + ' chars=' + totalChars + ' done in ' + elapsed + 'ms');
    }
};

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.stataUI;
}
