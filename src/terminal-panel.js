const { openArtifact, revealArtifact, copyToClipboard, resolveArtifactUri } = require('./artifact-utils');
const path = require('path');
const vscode = require('vscode');

/**
 * Parse SMCL text and extract formatted error information
 * @param {string} smclText - Raw SMCL text
 * @returns {{rc: number|null, formattedText: string}}
 */
function parseSMCL(smclText) {
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

    // 1. Extract return code from explicit tags as a priority
    if (!extractedRC) {
      // Look for Stata's standard return code search tag
      const searchMatch = line.match(/\{search r\((\d+)\)/i);
      if (searchMatch) {
        extractedRC = parseInt(searchMatch[1], 10);
      } else {
        // Look for the standard standalone return code line at the end
        const standaloneRC = trimmedLine.match(/^r\((\d+)\);$/);
        if (standaloneRC) {
          extractedRC = parseInt(standaloneRC[1], 10);
        }
      }
    }

    // 2. Detect error messages - ONLY capture from {err} tags
    const errMatch = line.match(/^\{err\}(.+)$/);
    if (errMatch) {
      hasError = true;
      const errorText = errMatch[1].trim().replace(/\{[^}]+\}/g, '');
      if (errorText) {
        errorMessages.push(errorText);
        if (errorLineIndex === -1) errorLineIndex = i;
      }
    }

    // 3. Track call stack - look for begin/end blocks
    const beginMatch = line.match(/begin\s+(\S+)/);
    if (beginMatch) {
      const funcName = beginMatch[1];
      if (errorLineIndex === -1 || i < errorLineIndex) {
        callStack.push(funcName);
      }
    }

    const endMatch = line.match(/end\s+(\S+)/);
    if (endMatch && callStack.length > 0) {
      // ONLY pop if we haven't found an error yet. This effectively "freezes" the stack state at the error.
      if (errorLineIndex === -1 || i < errorLineIndex) {
        const funcName = endMatch[1];
        if (callStack[callStack.length - 1] === funcName) {
          callStack.pop();
        }
      }
    }

    // 4. Capture executed commands - ONLY capture from {com} or '= ' lines
    if (trimmedLine.startsWith('= ')) {
      let cmd = trimmedLine.substring(2).trim();
      // Handle multiple prefixes
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

        // Strip prompt early so it doesn't trigger utility check for "."
        if (cmd.startsWith('. ')) {
          cmd = cmd.substring(2).trim();
        }

        // Handle multiple prefixes
        cmd = cmd.replace(/^((cap(ture)?|qui(etly)?|noi(sily)?)\s+)+/gi, '').trim();

        const isUtilityCmd = /^(loc(al)?|if|else|args|\.|\*|while|foreach|forvalues|continue|Cleanup|Drop|Clear)\b/i.test(cmd);
        if (!isUtilityCmd && cmd.length > 0 && (errorLineIndex === -1 || i < errorLineIndex)) {
          commandHistory.push(cmd);
          if (commandHistory.length > 3) commandHistory.shift();
        }
      }
    }
  }

  // Formatting return
  if (errorMessages.length === 0) {
    return {
      rc: extractedRC,
      formattedText: '',
      hasError: hasError
    };
  }

  // Filter out redundant "error ###" if we have more specific errors
  let filteredErrors = errorMessages.filter(e => e.length > 0);
  if (filteredErrors.length > 1) {
    const hasSpecificError = filteredErrors.some(e => !e.match(/^error \d+$/i));
    if (hasSpecificError) {
      filteredErrors = filteredErrors.filter(e => !e.match(/^error \d+$/i));
    }
  }

  const uniqueErrors = [...new Set(filteredErrors)];
  let parts = [];

  if (callStack.length > 0) {
    parts.push(`In: ${callStack.join(' → ')}`);
  }
  if (commandHistory.length > 0) {
    const cmd = commandHistory[commandHistory.length - 1];
    // Indent subsequent lines of the command for readability
    const formattedCmd = cmd.replace(/,\s+/g, ',\n    ').replace(/\s+(if|in|using)\s+/gi, '\n    $1 ').trim();
    parts.push(`\nCommand:\n  ${formattedCmd}`);
  }
  if (uniqueErrors.length > 0) {
    parts.push(`\nError: ${uniqueErrors.join('\n       ')}`);
  }

  return {
    rc: extractedRC,
    formattedText: parts.join('\n').trim(),
    hasError: hasError
  };
}

/**
 * Convert SMCL markup to HTML for display
 * @param {string} text - SMCL formatted text
 * @returns {string} HTML formatted text
 */
function smclToHtml(text) {
  if (!text) return '';

  // Handle case where . prompt is present but no {com} tag (fallback)
  let lines = text.split(/\r?\n/);
  lines = lines.map(line => {
    // Only apply fallback if line looks like a prompt and doesn't already have HTML/SMCL tags
    if (line.trim().startsWith('.') && !line.includes('<span') && !line.includes('{com}')) {
      return `{com}${line}{/com}`;
    }
    return line;
  });
  let processedText = lines.join('\n');

  // Remove global SMCL wrappers
  let html = processedText.replace(/\{smcl\}|\{\/smcl\}/gi, '');

  // 1. Basic entity cleaning
  html = html
    .replace(/&/g, '&amp;')
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

  // Handle character escapes for braces matches
  html = html.replace(/\{c -\(\}/g, '__BRACE_OPEN__').replace(/\{c \)-\}/g, '__BRACE_CLOSE__');

  // Regex for tokenization
  const tokenRegex = /(\{[^}]+\})|(\n)|([^{}\n]+)/g;

  let match;
  let result = '';
  // "First Principles": track column position to handle {col N}
  let currentLineLen = 0;

  // State for mode nesting prevention
  const MODE_TAGS = ['com', 'res', 'err', 'txt', 'input', 'result', 'text', 'error'];
  const openTags = [];

  while ((match = tokenRegex.exec(html)) !== null) {
    const fullMatch = match[0];
    const tag = match[1];
    const newline = match[2];
    const text = match[3];

    if (newline) {
      result += '\n';
      currentLineLen = 0;
      continue;
    }

    if (text) {
      result += text;
      // Decode entities for length calculation approximation
      let visibleLen = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').length;
      currentLineLen += visibleLen;
      continue;
    }

    if (tag) {
      // Strip braces for parsing
      const inner = tag.substring(1, tag.length - 1);

      // Handle {tag:content} syntax
      let tagName = inner;
      let tagContent = null;
      const firstColon = inner.indexOf(':');

      if (firstColon !== -1) {
        // Heuristic: Command is always first word.
        const cmdCandidate = inner.substring(0, firstColon).split(/\s+/)[0].toLowerCase();

        // If the command is NOT one of the positioning commands that typically use space-separated parameters,
        // then treat it as a tag:content structure.
        if (!['col', 'column', 'space', 'hline', '.-'].includes(cmdCandidate)) {
          tagName = inner.substring(0, firstColon);
          tagContent = inner.substring(firstColon + 1);
        }
      }

      const parts = tagName.split(/\s+/); // only split command part
      const command = parts[0].toLowerCase();

      // 1. Positioning Commands
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
        let len = 12; // default
        if (parts[1] && !isNaN(parseInt(parts[1]))) {
          len = parseInt(parts[1], 10);
        }
        const dashes = '-'.repeat(len);
        result += dashes;
        currentLineLen += len;
        continue;
      }

      if (command === '.-') {
        result += '-';
        currentLineLen += 1;
        continue;
      }

      // 2. Styling/Mode Commands
      if (command === 'ralign' || command === 'lalign' || command === 'center') {
        if (tagContent !== null) {
          let width = parseInt(parts[1], 10);
          let innerHtml = smclToHtml(tagContent);

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

      // Standard Mode Tags
      if (MODE_TAGS.includes(command) || command === '/' + openTags[openTags.length - 1]) {
        // If we have content {res:text}, wrap strict.
        if (tagContent !== null && MODE_TAGS.includes(command)) {
          result += startTag(command);
          let innerC = smclToHtml(tagContent);
          result += innerC;
          result += '</span>';

          let visibleText = innerC.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
          currentLineLen += visibleText.length;
          continue;
        }

        // Close existing if open
        if (openTags.length > 0) {
          const current = openTags[openTags.length - 1];
          if (MODE_TAGS.includes(command)) {
            result += `</span>`;
            openTags.pop();
          } else if (command === '/' + current) {
            result += `</span>`;
            openTags.pop();
            continue;
          }
        }

        // Open new
        if (MODE_TAGS.includes(command)) {
          const className = `smcl-${command}`;
          let extraClass = '';
          if (command === 'com') extraClass = ' syntax-highlight';
          result += `<span class="${className}${extraClass}">`;
          openTags.push(command);
        }
        continue;
      }

      // 3. Links and other complex tags (skip but keep simple)
      if (command === 'browse' || command === 'view') {
        continue;
      }
    }
  }

  // Close any remaining tags
  while (openTags.length > 0) {
    result += '</span>';
    openTags.pop();
  }

  // Restore placeholders
  result = result.replace(/__BRACE_OPEN__/g, '{').replace(/__BRACE_CLOSE__/g, '}');

  // Fallback for lines starting with . (legacy support)
  if (!result.includes('smcl-com')) {
    if (result.trim().startsWith('.') && !result.includes('smcl-')) {
      result = `<span class="smcl-com syntax-highlight">${result}</span>`;
    }
  }

  return result;
}

/**
 * Helper to start an HTML tag for SMCL
 */
function startTag(tagName) {
  const meta = getTagMeta(tagName);
  let className = meta.class ? ` class="${meta.class}"` : '';
  if (tagName === 'com') {
    className = ' class="smcl-com syntax-highlight"';
  }
  const dataAttrs = meta.data ? ` ${meta.data}` : '';
  return `<span${className}${dataAttrs}>`;
}

/**
 * Helper to wrap content in an HTML tag for SMCL
 */
function wrapTag(tagName, content) {
  const meta = getTagMeta(tagName);
  if (tagName === 'com') {
    // SPECIAL: Trigger syntax highlighting for command blocks
    // This is a marker for the UI to process the content
    return `<span class="smcl-com syntax-highlight">${content}</span>`;
  }
  const className = meta.class ? ` class="${meta.class}"` : '';
  const dataAttrs = meta.data ? ` ${meta.data}` : '';
  return `<span${className}${dataAttrs}>${content}</span>`;
}

/**
 * Maps SMCL tags to CSS classes and metadata
 */
function getTagMeta(tagName) {
  // Normalize tag name
  const tag = tagName.toLowerCase().split(/\s+/)[0];

  switch (tag) {
    case 'res': return { class: 'smcl-res' };
    case 'txt': return { class: 'smcl-txt' };
    case 'err': return { class: 'smcl-err' };
    case 'com': return { class: 'smcl-com' };
    case 'bf': return { class: 'smcl-bf' };
    case 'it': return { class: 'smcl-it' };
    case 'sf': return { class: 'smcl-sf' };
    case 'ul': return { class: 'smcl-ul' };
    case 'stata':
      // Handle {stata "cmd":label} - we'll just style it for now
      return { class: 'smcl-link', data: 'data-type="stata"' };
    case 'help':
      return { class: 'smcl-link', data: 'data-type="help"' };
    case 'browse':
      return { class: 'smcl-link', data: 'data-type="browse"' };
    default:
      return { class: '' };
  }
}


class TerminalPanel {
  static currentPanel = null;
  static extensionUri = null;
  static _testCapture = null;
  static _testOutgoingCapture = null;
  static variableProvider = null;
  static _defaultRunCommand = null;
  static _downloadGraphPdf = null;
  static _cancelHandler = null;
  static _clearHandler = null;
  static _activeRunId = null;
  static _activeFilePath = null;
  static _webviewReady = true;
  static _pendingWebviewMessages = [];

  static setExtensionUri(uri) {
    TerminalPanel.extensionUri = uri;
  }


  /**
  * Show (or reveal) the terminal panel and seed it with an initial entry.
   * @param {Object} options
   * @param {string} options.filePath
   * @param {string} options.initialCode
   * @param {object} options.initialResult
   * @param {(code: string, hooks?: object) => Promise<object>} options.runCommand
   * @param {(graphName: string) => Promise<void>} [options.downloadGraphPdf]
   * @param {() => Promise<void>} [options.cancelRun]
   * @param {() => Promise<void>} [options.clearAll]
   */
  static show({ filePath, initialCode, initialResult, runCommand, variableProvider, downloadGraphPdf, cancelRun, clearAll }) {
    const column = vscode.ViewColumn.Beside;
    TerminalPanel._activeFilePath = filePath || null;
    if (typeof variableProvider === 'function') {
      TerminalPanel.variableProvider = variableProvider;
    }
    if (typeof downloadGraphPdf === 'function') {
      TerminalPanel._downloadGraphPdf = downloadGraphPdf;
    }
    if (typeof cancelRun === 'function') {
      TerminalPanel._cancelHandler = cancelRun;
    }
    if (typeof clearAll === 'function') {
      TerminalPanel._clearHandler = clearAll;
    }
    if (!TerminalPanel.currentPanel) {
      TerminalPanel.currentPanel = vscode.window.createWebviewPanel(
        'stataTerminal',
        'Stata Terminal',
        column,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(TerminalPanel.extensionUri, 'src', 'ui-shared')
          ]
        }
      );

      TerminalPanel.currentPanel.onDidDispose(() => {
        TerminalPanel.currentPanel = null;
        TerminalPanel._webviewReady = true;
        TerminalPanel._pendingWebviewMessages = [];
      });

      TerminalPanel.currentPanel.webview.onDidReceiveMessage(async (message) => {
        if (!message || typeof message !== 'object') return;

        // Test hook
        if (TerminalPanel._testCapture) {
          TerminalPanel._testCapture(message);
        }

        if (message.type === 'ready') {
          TerminalPanel._webviewReady = true;
          TerminalPanel._flushPendingMessages();
          return;
        }

        if (message.type === 'openDataBrowser') {
          vscode.commands.executeCommand('stata-workbench.viewData');
          return;
        }

        if (message.type === 'showGraphs') {
          vscode.commands.executeCommand('stata-workbench.showGraphs');
          return;
        }

        if (message.type === 'run' && typeof message.code === 'string') {
          await TerminalPanel.handleRun(message.code, runCommand);
        }
        if ((message.command === 'download-graph-pdf' || message.type === 'downloadGraphPdf') && message.graphName) {
          await TerminalPanel._handleDownloadGraphPdf(message.graphName);
        }
        if (message.type === 'cancelRun') {
          await TerminalPanel._handleCancelRun();
        }
        if (message.type === 'clearAll') {
          await TerminalPanel._handleClearAll();
        }
        if (message.type === 'openArtifact' && message.path) {
          openArtifact(message.path, message.baseDir);
        }
        if (message.type === 'revealArtifact' && message.path) {
          await revealArtifact(message.path, message.baseDir);
        }
        if (message.type === 'copyArtifactPath' && message.path) {
          const uri = resolveArtifactUri(message.path, message.baseDir);
          if (uri?.scheme === 'file') {
            await copyToClipboard(uri.fsPath);
          } else if (uri) {
            await copyToClipboard(uri.toString());
          } else {
            await copyToClipboard(message.path);
          }
        }
        if (message.type === 'requestVariables') {
          const provider = TerminalPanel.variableProvider;
          if (typeof provider === 'function') {
            try {
              const vars = await provider();
              webview.postMessage({ type: 'variables', variables: vars || [] });
            } catch (error) {
              webview.postMessage({ type: 'variables', variables: [], error: error?.message || String(error) });
            }
          } else {
            webview.postMessage({ type: 'variables', variables: [] });
          }
        }
        if (message.type === 'log') {
          console.log(`[Client Log] ${message.level || 'info'}: ${message.message}`);
        }
      });

      const webview = TerminalPanel.currentPanel.webview;
      if (webview && typeof webview.postMessage === 'function' && !webview.__stataWorkbenchWrapped) {
        const originalPostMessage = webview.postMessage.bind(webview);
        webview.postMessage = (msg) => {
          try {
            if (TerminalPanel._testOutgoingCapture) {
              TerminalPanel._testOutgoingCapture(msg);
            }
          } catch (_err) {
          }
          return originalPostMessage(msg);
        };
        webview.__stataWorkbenchWrapped = true;
      }
    }

    const webview = TerminalPanel.currentPanel.webview;
    if (typeof runCommand === 'function') {
      TerminalPanel._defaultRunCommand = runCommand;
    }
    const nonce = getNonce();

    // Convert initial data to history entry format for embedding
    const initialHistory = (initialCode && initialResult)
      ? [toEntry(initialCode, initialResult)]
      : [];

    TerminalPanel.currentPanel.webview.html = renderHtml(webview, TerminalPanel.extensionUri, nonce, filePath, initialHistory);
    TerminalPanel._webviewReady = false;
    TerminalPanel._pendingWebviewMessages = [];
    TerminalPanel.currentPanel.reveal(column);

  }

  static _postMessage(msg) {
    if (!TerminalPanel.currentPanel) return;
    const webview = TerminalPanel.currentPanel.webview;
    if (!webview || typeof webview.postMessage !== 'function') return;
    if (!TerminalPanel._webviewReady) {
      TerminalPanel._pendingWebviewMessages.push(msg);
      return;
    }
    webview.postMessage(msg);
  }

  static _flushPendingMessages() {
    if (!TerminalPanel.currentPanel) return;
    if (!TerminalPanel._webviewReady) return;
    const pending = Array.isArray(TerminalPanel._pendingWebviewMessages)
      ? TerminalPanel._pendingWebviewMessages
      : [];
    TerminalPanel._pendingWebviewMessages = [];
    for (const msg of pending) {
      TerminalPanel._postMessage(msg);
    }
  }

  static updateDatasetSummary(n, k) {
    TerminalPanel._postMessage({ type: 'datasetSummary', n, k });
  }

  static async handleRun(code, runCommand) {
    if (!TerminalPanel.currentPanel) return;
    const trimmed = (code || '').trim();
    if (!trimmed) return;

    const runId = TerminalPanel._generateRunId();
    TerminalPanel._activeRunId = runId;
    TerminalPanel._postMessage({ type: 'busy', value: true });
    TerminalPanel._postMessage({ type: 'runStarted', runId, code: trimmed });

    try {
      const cwd = TerminalPanel._activeFilePath ? path.dirname(TerminalPanel._activeFilePath) : null;
      const hooks = {
        onLog: (text) => {
          if (!text) return;
          TerminalPanel._postMessage({ type: 'runLogAppend', runId, text: smclToHtml(String(text)) });
        },
        onProgress: (progress, total, message) => {
          TerminalPanel._postMessage({ type: 'runProgress', runId, progress, total, message });
        },
        cwd
      };

      const result = await runCommand(trimmed, hooks);

      // Parse SMCL stdout + stderr to extract RC and format
      let finalRC = typeof result?.rc === 'number' ? result.rc : null;
      let finalStderr = result?.stderr || '';

      const combinedForRC = (result?.stdout || result?.contentText || '') + '\n' + (result?.stderr || '');
      const parsed = parseSMCL(combinedForRC);

      if (parsed.rc !== null) {
        finalRC = parsed.rc;
      }

      if (finalRC === -1 || finalRC === null) {
        if (combinedForRC.includes('unrecognized command') || combinedForRC.includes('is unrecognized')) {
          finalRC = 199;
        }
      }

      if (parsed.formattedText) {
        const smclContext = parsed.formattedText
          .split('\n')
          .map(line => {
            if (line.startsWith('In:') || line.startsWith('Command:')) {
              return `{txt}${line}`;
            }
            if (line.startsWith('Error:')) {
              return `{err}${line}`;
            }
            return `{txt}${line}`;
          })
          .join('\n');

        if (finalStderr) {
          finalStderr = `${smclContext}\n{res}{hline}\n${finalStderr}`;
        } else {
          finalStderr = smclContext;
        }
      }

      // Determine success using parsed RC
      const success = determineSuccess(result, finalRC);

      TerminalPanel._postMessage({
        type: 'runFinished',
        runId,
        rc: finalRC,
        success,
        hasError: parsed.hasError,
        durationMs: result?.durationMs ?? null,
        // Main stdout: only show if success=true.
        stdout: success ? smclToHtml(result?.stdout || result?.contentText || '') : '',
        // fullStdout: always available for the 'Log' tab.
        fullStdout: smclToHtml(result?.stdout || result?.contentText || ''),
        stderr: success ? '' : smclToHtml(finalStderr),
        artifacts: normalizeArtifacts(result),
        baseDir: result?.cwd || ''
      });
    } catch (error) {
      TerminalPanel._postMessage({ type: 'runFailed', runId, message: error?.message || String(error) });
    } finally {
      TerminalPanel._activeRunId = null;
      TerminalPanel._postMessage({ type: 'busy', value: false });
    }
  }

  static async _handleDownloadGraphPdf(graphName) {
    if (typeof TerminalPanel._downloadGraphPdf !== 'function') return;
    try {
      await TerminalPanel._downloadGraphPdf(graphName);
      TerminalPanel._postMessage({ type: 'downloadStatus', success: true, graphName });
    } catch (error) {
      console.error('[TerminalPanel] downloadGraphPdf failed:', error);
      TerminalPanel._postMessage({
        type: 'downloadStatus',
        success: false,
        graphName,
        message: error?.message || String(error)
      });
    }
  }

  static async _handleCancelRun() {
    if (typeof TerminalPanel._cancelHandler === 'function') {
      try {
        await TerminalPanel._cancelHandler();
        // Optimistically mark the active run as cancelled in the UI.
        const runId = TerminalPanel._activeRunId;
        if (runId) {
          TerminalPanel._postMessage({ type: 'runCancelled', runId, message: 'Run cancelled by user.' });
          TerminalPanel._postMessage({ type: 'busy', value: false });
        }
      } catch (error) {
        console.error('[TerminalPanel] cancelRun failed:', error);
      }
    }
  }

  static startStreamingEntry(code, filePath, runCommand, variableProvider, cancelRun, downloadGraphPdf) {
    const trimmed = (code || '').trim();
    if (!trimmed) return null;

    TerminalPanel._activeFilePath = filePath || TerminalPanel._activeFilePath || null;
    if (typeof variableProvider === 'function') {
      TerminalPanel.variableProvider = variableProvider;
    }
    if (typeof runCommand === 'function') {
      TerminalPanel._defaultRunCommand = runCommand;
    }
    if (typeof cancelRun === 'function') {
      TerminalPanel._cancelHandler = cancelRun;
    }
    if (typeof downloadGraphPdf === 'function') {
      TerminalPanel._downloadGraphPdf = downloadGraphPdf;
    }

    if (!TerminalPanel.currentPanel) {
      TerminalPanel.show({
        filePath,
        initialCode: null,
        initialResult: null,
        runCommand: runCommand || TerminalPanel._defaultRunCommand || (async () => { throw new Error('Session not fully initialized'); }),
        variableProvider: variableProvider || TerminalPanel.variableProvider,
        downloadGraphPdf: TerminalPanel._downloadGraphPdf,
        cancelRun: TerminalPanel._cancelHandler,
        clearAll: TerminalPanel._clearHandler
      });
    }

    if (!TerminalPanel.currentPanel) return null;
    const runId = TerminalPanel._generateRunId();
    TerminalPanel._postMessage({ type: 'busy', value: true });
    TerminalPanel._postMessage({ type: 'runStarted', runId, code: trimmed });
    TerminalPanel.currentPanel.reveal(vscode.ViewColumn.Beside);
    return runId;
  }

  static appendStreamingLog(runId, text) {
    if (!TerminalPanel.currentPanel || !runId) return;
    const chunk = String(text ?? '');
    if (!chunk) return;
    TerminalPanel._postMessage({ type: 'runLogAppend', runId, text: smclToHtml(chunk) });
  }

  static updateStreamingProgress(runId, progress, total, message) {
    if (!TerminalPanel.currentPanel || !runId) return;
    TerminalPanel._postMessage({ type: 'runProgress', runId, progress, total, message });
  }

  static finishStreamingEntry(runId, result) {
    if (!TerminalPanel.currentPanel || !runId) return;

    // Parse SMCL stdout + stderr to extract RC and format
    let finalRC = typeof result?.rc === 'number' ? result.rc : null;
    let finalStderr = result?.stderr || '';

    const combinedForRC = (result?.stdout || result?.contentText || '') + '\n' + (result?.stderr || '');
    const parsed = parseSMCL(combinedForRC);

    if (parsed.rc !== null) {
      finalRC = parsed.rc;
    }

    if (finalRC === -1 || finalRC === null) {
      if (combinedForRC.includes('unrecognized command') || combinedForRC.includes('is unrecognized')) {
        console.log('[RC Fallback] Unrecognized command detected -> RC 199');
        finalRC = 199;
      }
    }

    if (finalStderr && parsed.formattedText) {
      finalStderr = parsed.formattedText;
    }

    // NOW determine success using the parsed RC
    const success = determineSuccess(result, finalRC);

    TerminalPanel._postMessage({
      type: 'runFinished',
      runId,
      rc: finalRC,
      success,
      durationMs: result?.durationMs ?? null,
      // Do not ship full stdout on failure; rely on stderr/tail.
      // Apply smclToHtml to the final result
      stdout: success ? smclToHtml(result?.stdout || result?.contentText || '') : '',
      stderr: success ? '' : smclToHtml(finalStderr),
      artifacts: normalizeArtifacts(result),
      baseDir: result?.cwd || ''
    });
    TerminalPanel._postMessage({ type: 'busy', value: false });
  }

  static failStreamingEntry(runId, errorMessage) {
    if (!TerminalPanel.currentPanel || !runId) return;
    TerminalPanel._postMessage({ type: 'runFailed', runId, message: errorMessage });
    TerminalPanel._postMessage({ type: 'busy', value: false });
  }

  static _generateRunId() {
    return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
  * Appends an entry to the terminal panel, showing it if necessary.
   * @param {string} code
   * @param {object} result
   * @param {string} [filePath] - associated file path to update title if needed
   * @param {(code: string) => Promise<object>} [runCommand] - command runner if panel needs initialization
   */
  static addEntry(code, result, filePath, runCommand, variableProvider) {
    if (!TerminalPanel.currentPanel) {
      // If panel not open, open it with this as initial state
      if (typeof runCommand === 'function') {
        TerminalPanel._defaultRunCommand = runCommand;
      }
      if (typeof variableProvider === 'function') {
        TerminalPanel.variableProvider = variableProvider;
      }
      TerminalPanel.show({
        filePath,
        initialCode: code,
        initialResult: result,
        runCommand: runCommand || (async () => { throw new Error('Session not fully initialized'); }),
        variableProvider: variableProvider || TerminalPanel.variableProvider,
        downloadGraphPdf: TerminalPanel._downloadGraphPdf,
        cancelRun: TerminalPanel._cancelHandler,
        clearAll: TerminalPanel._clearHandler
      });
      return;
    }

    TerminalPanel._activeFilePath = filePath || TerminalPanel._activeFilePath || null;

    // Panel exists, just append
    TerminalPanel._postMessage({
      type: 'append',
      entry: toEntry(code, result)
    });

    // Explicitly reveal it
    TerminalPanel.currentPanel.reveal(vscode.ViewColumn.Beside);
  }

  static async _handleClearAll() {
    if (typeof TerminalPanel._clearHandler === 'function') {
      try {
        // Clear UI first, before running command
        TerminalPanel._postMessage({ type: 'cleared' });
        TerminalPanel._postMessage({ type: 'busy', value: true });
        await TerminalPanel._clearHandler();
        // Success - UI already cleared, no need to show anything
      } catch (error) {
        console.error('[TerminalPanel] clearAll failed:', error);
        TerminalPanel._postMessage({ type: 'error', message: 'Failed to clear: ' + error.message });
      } finally {
        TerminalPanel._postMessage({ type: 'busy', value: false });
      }
      return;
    }
    // Fallback: clear UI first, then run command silently
    TerminalPanel._postMessage({ type: 'cleared' });
    if (typeof TerminalPanel._defaultRunCommand === 'function') {
      // Run silently in background without showing in terminal
      try {
        await TerminalPanel._defaultRunCommand('clear all', {});
      } catch (error) {
        TerminalPanel._postMessage({ type: 'error', message: 'Failed to clear: ' + error.message });
      }
    }
  }

}

module.exports = { TerminalPanel, toEntry, normalizeArtifacts, parseSMCL, smclToHtml, determineSuccess };

function renderHtml(webview, extensionUri, nonce, filePath, initialEntries = []) {
  const designUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'design.css'));
  const highlightCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'highlight.css'));
  const mainJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'main.js'));
  const highlightJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'highlight.min.js'));

  const fileName = filePath ? path.basename(filePath) : 'Terminal Session';
  const escapedTitle = escapeHtml(fileName);
  const initialJson = JSON.stringify(initialEntries).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource} https://unpkg.com; font-src ${webview.cspSource} https://unpkg.com;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${designUri}">
  <link rel="stylesheet" href="${highlightCssUri}">
  <title>Stata Terminal</title>
  <script nonce="${nonce}">
    window.initialEntries = ${initialJson};
  </script>
  <style nonce="${nonce}">
    /* Override highlight.js background to blend with terminal */
    .hljs { background: transparent !important; padding: 0 !important; }
    @import url('https://unpkg.com/@vscode/codicons@0.0.44/dist/codicon.css');

    #btn-open-browser {
      padding: 4px;
      height: 24px;
      width: 24px;
      justify-content: center;
    }

    .data-summary {
      display: flex;
      gap: var(--space-sm);
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--text-secondary);
      background: rgba(255, 255, 255, 0.03);
      padding: 2px 8px;
      border-radius: var(--radius-pill);
      border: 1px solid var(--border-subtle);
    }

    .summary-item {
      display: flex;
      gap: 4px;
    }

    .summary-item span {
      color: var(--text-primary);
      font-weight: 600;
    }
  </style>
</head>
<body>

  <!-- Context Header -->
  <div class="context-header" id="context-header">
    <div class="context-container">
      <div class="context-info">
        <div class="context-row">
          <span class="context-label">File:</span>
          <span class="context-value" id="context-file">${escapedTitle}</span>
        </div>
        <div class="context-row">
          <span class="context-label">Last command:</span>
          <span class="context-value context-command" id="last-command">—</span>
          <span class="context-label" style="margin-left: 16px;">Status:</span>
          <span class="context-value">
            <span class="status-indicator" id="status-indicator" style="color: var(--text-muted); font-size:16px;">●</span>
            <span id="status-rc" style="margin-left: 4px;"></span>
          </span>
        </div>
      </div>
      <div class="context-right">
        <div class="data-summary" id="data-summary" style="display: none;">
          <span class="summary-item">n: <span id="obs-count">0</span></span>
          <span class="summary-item">v: <span id="var-count">0</span></span>
        </div>
        <button class="btn btn-ghost btn-icon" id="btn-open-browser" title="Open Data Browser">
          <i class="codicon codicon-table"></i>
        </button>
        <button class="btn btn-ghost btn-icon" id="btn-show-graphs" title="Show Graphs">
          <i class="codicon codicon-graph"></i>
        </button>
      </div>
    </div>
  </div>

  <main class="chat-stream" id="chat-stream">
    <!-- Entries injected here -->
  </main>

  <div class="artifact-modal hidden" id="artifact-modal" role="dialog" aria-modal="true" aria-hidden="true">
    <div class="artifact-modal-overlay" data-action="close-artifact-modal"></div>
    <div class="artifact-modal-panel">
      <div class="artifact-modal-header">
        <div class="artifact-modal-title" id="artifact-modal-title"></div>
        <button class="btn btn-sm" data-action="close-artifact-modal" type="button">Close</button>
      </div>
      <div class="artifact-modal-body">
        <img class="artifact-modal-img" id="artifact-modal-img" alt="" />
        <div class="artifact-modal-meta" id="artifact-modal-meta"></div>
      </div>
      <div class="artifact-modal-actions">
        <button class="btn btn-sm" id="artifact-modal-open" type="button">Open</button>
        <button class="btn btn-sm" id="artifact-modal-reveal" type="button">Reveal</button>
        <button class="btn btn-sm" id="artifact-modal-copy" type="button">Copy path</button>
        <button class="btn btn-sm btn-primary" id="artifact-modal-download" type="button">Download PDF</button>
      </div>
    </div>
  </div>

  <!-- Floating Input Area -->
  <footer class="input-area">
    <div class="input-container">
      <textarea id="command-input" placeholder="Run Stata command..." rows="1" autofocus></textarea>
      <div class="input-footer">
        <div class="key-hint">
          <span class="kbd">Enter</span><span>run</span>
          <span class="kbd">PgUp/Down</span><span>prev/next</span>
          <span class="kbd">Tab</span><span>complete</span>
        </div>
        <div class="input-actions">
          <button id="clear-btn" class="btn btn-sm btn-ghost" title="Clear all (Stata)">
            <i class="codicon codicon-trash"></i>
            <span>Clear</span>
          </button>
          <button id="stop-btn" class="btn btn-sm btn-ghost" title="Stop current run">
            <i class="codicon codicon-debug-stop"></i>
            <span>Stop</span>
          </button>
          <button id="run-btn" class="btn btn-primary btn-sm">
            <i class="codicon codicon-play"></i>
            <span>Run</span>
          </button>
        </div>
      </div>
    </div>
  </footer>

  <script src="${highlightJsUri}"></script>
  <script src="${mainJsUri}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    vscode.postMessage({ type: 'log', level: 'info', message: 'Terminal webview booted' });

    // Defensive: if shared UI script fails to load, provide minimal helpers so the terminal still works.
    if (!window.stataUI) {
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
                return m + 'm ' + rem.toFixed(0) + 's';
            },
            bindArtifactEvents: function () { }
        };
    }
    
    // Global error handler to surface script errors to extension
    window.onerror = function(message, source, lineno, colno, error) {
        vscode.postMessage({
            type: 'log',
            level: 'error',
            message: 'Client Error: ' + message + ' (' + source + ':' + lineno + ')'
        });
    };

    let highlightTimer = null;
    function scheduleHighlight() {
        if (highlightTimer) clearTimeout(highlightTimer);
        highlightTimer = setTimeout(() => {
            if (window.stataUI && window.stataUI.processSyntaxHighlighting) {
                window.stataUI.processSyntaxHighlighting();
            }
            highlightTimer = null;
        }, 100);
    }
    
    // Initial load
    document.addEventListener('DOMContentLoaded', () => {
        if (window.stataUI && window.stataUI.processSyntaxHighlighting) {
            window.stataUI.processSyntaxHighlighting();
        }
    });

    // Listen for new messages
    window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'runLogAppend' || message.type === 'append' || message.type === 'runFinished') {
            scheduleHighlight();
        }
    });
    
    const chatStream = document.getElementById('chat-stream');
    const input = document.getElementById('command-input');
    const runBtn = document.getElementById('run-btn');
    const stopBtn = document.getElementById('stop-btn');
    const clearBtn = document.getElementById('clear-btn');
    const btnOpenBrowser = document.getElementById('btn-open-browser');
    const btnShowGraphs = document.getElementById('btn-show-graphs');
    const dataSummary = document.getElementById('data-summary');
    const obsCount = document.getElementById('obs-count');
    const varCount = document.getElementById('var-count');
    
    if (btnOpenBrowser) {
        btnOpenBrowser.addEventListener('click', () => {
            vscode.postMessage({ type: 'openDataBrowser' });
        });
    }

    if (btnShowGraphs) {
        btnShowGraphs.addEventListener('click', () => {
            vscode.postMessage({ type: 'showGraphs' });
        });
    }

    // Initial history embedded from server
    const initialEntries = window.initialEntries || [];
    const history = [];
    let historyIndex = -1; // -1 means not currently traversing history
    const variables = [];
    let variablesPending = false;
    let lastCompletion = null;

    const runs = Object.create(null);

    let busy = false;

    function clearAllOutput() {
        // Clear the chat stream
        if (chatStream) {
            chatStream.innerHTML = '';
        }
        
        // Reset runs tracking
        for (const key in runs) {
            delete runs[key];
        }
        
        // Reset history
        history.length = 0;
        historyIndex = -1;
        
        // Reset last command display
        updateLastCommand('—');
        
        // Reset status indicator
        updateStatusIndicator(null, null);
        
        // Clear any optimistic messages
        const optimistic = chatStream.querySelectorAll('[data-optimistic="true"]');
        optimistic.forEach(el => el.remove());
        
        // Reset scroll
        autoScrollPinned = true;
        scrollToBottom();
    }

    function safeSliceTail(html, limit) {
        if (!html || html.length <= limit) return html || '';
        let start = html.length - limit;
        // Search for the first newline after the potential cut point.
        // This ensures we start on a fresh line, avoiding broken tags.
        const firstNewline = html.indexOf(String.fromCharCode(10), start);
        const firstTagStart = html.indexOf('<', start);
        
        let cutPoint = -1;
        let offset = 1; // default to skipping the delimiter (like newline)

        if (firstNewline !== -1 && firstTagStart !== -1) {
            // Both found, take earliest
            if (firstNewline < firstTagStart) {
                cutPoint = firstNewline;
                offset = 1; // skip \n
            } else {
                cutPoint = firstTagStart;
                offset = 0; // keep <
            }
        } else if (firstNewline !== -1) {
            cutPoint = firstNewline;
            offset = 1;
        } else if (firstTagStart !== -1) {
            cutPoint = firstTagStart;
            offset = 0;
        }

        if (cutPoint !== -1 && cutPoint < html.length - 1) {
            return html.substring(cutPoint + offset);
        }
        return html.slice(-limit);
    }

    function scrollToBottom() {
        const top = document.body.scrollHeight;
        try {
            window.scrollTo({ top, left: 0, behavior: 'auto' });
        } catch (_err) {
            window.scrollTo(0, top);
        }
    }

    function scrollToBottomSmooth() {
        const durationMs = 180;
        const startY = window.scrollY || 0;
        const startTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

        const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

        const step = (now) => {
            const tNow = now ?? ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());
            const elapsed = tNow - startTime;
            const t = Math.max(0, Math.min(1, elapsed / durationMs));
            const eased = easeOutCubic(t);

            const targetY = document.body.scrollHeight;
            const nextY = startY + (targetY - startY) * eased;
            window.scrollTo(0, nextY);

            if (t < 1) {
                requestAnimationFrame(step);
            } else {
                scrollToBottom();
            }
        };

        requestAnimationFrame(step);
    }

    let autoScrollPinned = true;
    let scrollScheduled = false;

    function scheduleScrollToBottom() {
        if (scrollScheduled) return;
        scrollScheduled = true;
        requestAnimationFrame(() => {
            scrollScheduled = false;
            scrollToBottom();
        });
    }

    function updateStatusIndicator(success, rc) {
        const indicator = document.getElementById('status-indicator');
        const rcDisplay = document.getElementById('status-rc');
        
        if (!indicator) return;
        
        if (success === null || success === undefined) {
            // No status yet or reset
            indicator.style.color = 'var(--text-muted)';
            if (rcDisplay) rcDisplay.textContent = '';
            return;
        }
        
        if (success) {
            indicator.style.color = 'var(--accent-success)';
        } else {
            indicator.style.color = 'var(--accent-error)';
        }
        
        if (rcDisplay) {
            rcDisplay.textContent = (rc !== null && rc !== undefined) ? ('RC ' + rc) : '';
        }
    }

    // ... (rest of the listeners) ...

    // Auto-resize textarea
    input.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 200) + 'px';
      if (this.value === '') this.style.height = 'auto';
      lastCompletion = null;
    });

    // Handle keys
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doRun();
        return;
      }

      if (e.key === 'Tab') {
        // Always prevent focus from leaving the input; attempt completion if possible.
        e.preventDefault();
        const used = handleTabCompletion();
        if (!used) {
          requestVariables();
        }
        return;
      }

      if (e.key === 'PageUp') {
        // Navigate backward through history
        if (history.length === 0) return;
        e.preventDefault();
        if (historyIndex === -1) {
          historyIndex = history.length - 1;
        } else if (historyIndex > 0) {
          historyIndex -= 1;
        }
        applyHistory();
        return;
      }

      if (e.key === 'PageDown') {
        // Navigate forward through history (or clear if past newest)
        if (historyIndex === -1) return;
        e.preventDefault();
        if (historyIndex < history.length - 1) {
          historyIndex += 1;
          applyHistory();
        } else {
          historyIndex = -1;
          clearInput();
        }
      }
    });

    runBtn.addEventListener('click', doRun);
    if (stopBtn) {
        stopBtn.addEventListener('click', () => {
            if (!busy) return;
            stopBtn.disabled = true;
            vscode.postMessage({ type: 'cancelRun' });
            // Re-enable after a short delay in case host doesn't respond immediately
            setTimeout(() => { if (busy) stopBtn.disabled = false; }, 1200);
        });
    }

    if (clearBtn) {
    clearBtn.addEventListener('click', () => {
        if (busy) return;
        setBusy(true);
        
        // Clear UI immediately for better UX
        clearAllOutput();
        
        // Send message to extension to clear Stata session
        vscode.postMessage({ type: 'clearAll' });
    });
}

    // Bind shared artifact events (delegated)
    if (window.stataUI && typeof window.stataUI.bindArtifactEvents === 'function') {
        window.stataUI.bindArtifactEvents(vscode);
    }

    // Tab switching logic (delegated)
    document.addEventListener('click', (e) => {
        const tabBtn = e.target.closest('.tab-btn');
        if (tabBtn) {
            const runId = tabBtn.dataset.runId;
            const tab = tabBtn.dataset.tab; // 'result' or 'log'
            if (!runId || !tab) return;

            const card = tabBtn.closest('.output-card');
            if (!card) return;

            // Update buttons
            card.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            tabBtn.classList.add('active');

            // Update panes
            card.querySelectorAll('.output-pane').forEach(pane => pane.classList.remove('active'));
            const targetPane = card.querySelector('.output-pane[data-tab="' + tab + '"]');
            if (targetPane) targetPane.classList.add('active');
        }
    });

    function requestVariables() {
      if (variablesPending) return;
      variablesPending = true;
      vscode.postMessage({ type: 'requestVariables' });
    }

    function updateLastCommand(code) {
        const lastCmd = document.getElementById('last-command');
        if (lastCmd) {
            lastCmd.textContent = code;
            lastCmd.title = code; // Full text on hover
        }
    }

    function doRun() {
      if (busy) return;
      const code = input.value.trim();
      if (!code) return;

      updateLastCommand(code);
      updateStatusIndicator(null, null); // Reset status indicator when starting new run
      vscode.postMessage({ type: 'run', code });

      autoScrollPinned = true;

      // Optimistically append user message
      appendUserMessage(code);

      scrollToBottomSmooth();

      clearInput();
      historyIndex = -1; // reset traversal once we run a new command
    }

    function clearInput() {
      input.value = '';
      input.style.height = 'auto';
      input.focus();
    }

    function applyHistory() {
      if (historyIndex < 0 || historyIndex >= history.length) return;
      input.value = history[historyIndex] || '';
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 200) + 'px';
      // Move cursor to end for quick editing
      const len = input.value.length;
      input.setSelectionRange(len, len);
      lastCompletion = null;
    }

    function setBusy(value) {
        busy = value;
        if (runBtn) {
            runBtn.disabled = value;
            runBtn.style.opacity = value ? 0.7 : 1;
        }
        if (stopBtn) {
            stopBtn.disabled = !value;
            stopBtn.style.opacity = value ? 1 : 0.6;
        }
        if (clearBtn) {
            clearBtn.disabled = value;
            clearBtn.style.opacity = value ? 0.6 : 1;
        }
        if (!value) setTimeout(() => input.focus(), 50);
    }

    function appendUserMessage(code) {
        const div = document.createElement('div');
        div.className = 'message-group';
        div.dataset.optimistic = 'true';
        div.innerHTML = \`
            <div class="user-bubble">
                \${window.stataUI.escapeHtml(code)}
            </div>
        \`;
        chatStream.appendChild(div);
        if (autoScrollPinned) scrollToBottom();
    }

    function ensureRunGroup(runId, code) {
        if (runs[runId]) return runs[runId];

        const lastGroup = chatStream.lastElementChild;
        if (lastGroup && lastGroup.dataset.optimistic) {
            lastGroup.remove();
        }

        if (code) {
          history.push(code);
          historyIndex = -1;
        }

        updateLastCommand(code || '');

        const userHtml = code ? (
            '<div class="user-bubble">'
            + window.stataUI.escapeHtml(code)
            + '</div>'
        ) : '';

        const systemHtml =
            '<div class="system-bubble">'
            +  '<div class="output-card">'
            +    '<div class="output-header">'
            +      '<div class="flex items-center gap-xs">'
            +        '<span class="text-muted" id="run-status-dot-' + runId + '" style="color: var(--accent-warning); font-size:16px;">●</span>'
            +        '<span id="run-status-title-' + runId + '">Stata Output (running…)</span>'
            +      '</div>'
            +      '<div class="flex items-center gap-sm">'
            +        '<span id="run-rc-' + runId + '"></span>'
            +        '<span id="run-duration-' + runId + '"></span>'
            +      '</div>'
            +    '</div>'
            +    '<div class="output-progress" id="run-progress-wrap-' + runId + '" style="display:none;">'
            +      '<div class="progress-row">'
            +        '<span class="progress-text" id="run-progress-text-' + runId + '"></span>'
            +        '<span class="progress-meta" id="run-progress-meta-' + runId + '"></span>'
            +      '</div>'
            +      '<div class="progress-bar"><div class="progress-fill" id="run-progress-fill-' + runId + '" style="width:0%;"></div></div>'
            +    '</div>'
            +    '<div class="output-tabs" id="run-tabs-' + runId + '" style="display:none;">'
            +      '<button class="tab-btn active" data-run-id="' + runId + '" data-tab="result">Result</button>'
            +      '<button class="tab-btn" data-run-id="' + runId + '" data-tab="log">Log</button>'
            +    '</div>'
            +    '<div class="output-pane active" data-tab="result">'
            +      '<div class="output-content error" id="run-stderr-' + runId + '" style="display:none;"></div>'
            +      '<div class="output-content" id="run-stdout-' + runId + '"></div>'
            +    '</div>'
            +    '<div class="output-pane" data-tab="log">'
            +      '<div class="output-content" id="run-log-' + runId + '"></div>'
            +    '</div>'
            +  '</div>'
            +  '<div id="run-artifacts-' + runId + '"></div>'
            + '</div>';

        const div = document.createElement('div');
        div.className = 'message-group entry';
        div.dataset.runId = runId;
        div.innerHTML = userHtml + systemHtml;
        chatStream.appendChild(div);
        if (autoScrollPinned) scrollToBottom();

        runs[runId] = {
            group: div,
            stdoutEl: document.getElementById('run-stdout-' + runId),
            stderrEl: document.getElementById('run-stderr-' + runId),
            progressWrap: document.getElementById('run-progress-wrap-' + runId),
            progressText: document.getElementById('run-progress-text-' + runId),
            progressMeta: document.getElementById('run-progress-meta-' + runId),
            progressFill: document.getElementById('run-progress-fill-' + runId),
            statusDot: document.getElementById('run-status-dot-' + runId),
            statusTitle: document.getElementById('run-status-title-' + runId),
            rcEl: document.getElementById('run-rc-' + runId),
            durationEl: document.getElementById('run-duration-' + runId),
            logEl: document.getElementById('run-log-' + runId),
            tabsContainer: document.getElementById('run-tabs-' + runId),
            artifactsEl: document.getElementById('run-artifacts-' + runId)
        };

        return runs[runId];
    }

    function appendEntry(entry) {
        const lastGroup = chatStream.lastElementChild;
        if (lastGroup && lastGroup.dataset.optimistic) {
            lastGroup.remove();
        }

      if (entry.code) {
        history.push(entry.code);
        historyIndex = -1; // newest entry resets traversal
      }

        // Update last command in header
        updateLastCommand(entry.code);
        
        // Update status indicator in header
        updateStatusIndicator(entry.success, entry.rc);

        // Build HTML
        const userHtml = \`
    <div class="user-bubble" >
  \${ window.stataUI.escapeHtml(entry.code) }
            </div>
    \`;

        let outputContent = '';
        const statusLabel = entry.success ? 'Stata Output' : 'Stata Output (error)';
        if (entry.stderr) {
            outputContent += \`<div class="output-content error">\${entry.stderr}</div>\`;
        }
        if (entry.stdout) {
            outputContent += '<div class="output-content">' + entry.stdout + '</div>';
        }
        
        const artifactsHtml = renderArtifacts(entry.artifacts, entry.timestamp);

        // Determine traffic light color
        const statusColor = entry.success ? 'var(--accent-success)' : 'var(--accent-error)';

        // Determine if we should show tabs
        const hasProblem = !entry.success || entry.hasError || (entry.rc !== null && entry.rc !== 0);
        const tabsStyle = hasProblem ? '' : 'style="display:none;"';

        // System Bubble (Card)
        const systemHtml =
            '<div class="system-bubble">'
            +   '<div class="output-card">'
            +     '<div class="output-header">'
            +       '<div class="flex items-center gap-xs">'
            +         '<span class="' + (entry.success ? 'text-muted' : 'text-error') + '" style="color: ' + statusColor + '; font-size:16px;">●</span>'
            +         '<span>' + statusLabel + '</span>'
            +       '</div>'
            +       '<div class="flex items-center gap-sm">'
            +         (entry.rc !== null ? ('<span>RC ' + entry.rc + '</span>') : '')
            +         (entry.durationMs ? ('<span>' + window.stataUI.formatDuration(entry.durationMs) + '</span>') : '')
            +       '</div>'
            +     '</div>'
            +     '<div class="output-tabs" ' + tabsStyle + '>'
            +       '<button class="tab-btn active" data-run-id="' + entry.timestamp + '" data-tab="result">Result</button>'
            +       '<button class="tab-btn" data-run-id="' + entry.timestamp + '" data-tab="log">Log</button>'
            +     '</div>'
            +     '<div class="output-pane active" data-tab="result">'
            +       (entry.stderr ? ('<div class="output-content error">' + entry.stderr + '</div>') : '')
            +       (entry.stdout ? ('<div class="output-content">' + entry.stdout + '</div>') : '')
            +     '</div>'
            +     '<div class="output-pane" data-tab="log">'
            +       '<div class="output-content">' + (entry.fullStdout || '') + '</div>'
            +     '</div>'
            +   '</div>'
            +   artifactsHtml
            + '</div>';

        const div = document.createElement('div');
        div.className = 'message-group entry';
        div.innerHTML = userHtml + systemHtml;
        chatStream.appendChild(div);
        if (autoScrollPinned) scrollToBottom();
    }

    function renderArtifacts(artifacts, id) {
        if (!artifacts || !Array.isArray(artifacts) || artifacts.length === 0) return '';
        const artifactsId = window.stataUI.escapeHtml(String(id || Date.now()));
        const isCollapsed = collapsedArtifacts[artifactsId] === true;

        const tiles = artifacts.map((a, idx) => {
          const label = window.stataUI.escapeHtml(a.label || 'graph');
          const preview = a.dataUri || a.path; // Already converted to data URI by Node.js code
          const canPreview = !!preview && (String(preview).indexOf('data:image/') !== -1);
          
          const error = a.error ? String(a.error) : '';
          const errorHtml = error
              ? '<div class="artifact-tile-error">' + window.stataUI.escapeHtml(error) + '</div>'
              : '';
          const thumbHtml = canPreview
              ? '<img src="' + window.stataUI.escapeHtml(preview) + '" class="artifact-thumb-img" alt="' + label + '">' 
              : '<div class="artifact-thumb-fallback">PDF</div>';

            const tileAttrs = canPreview
                ? ('data-action="preview-graph" data-src="' + window.stataUI.escapeHtml(preview) + '"')
                : 'data-action="open-artifact"';

            return (
                '<div class="artifact-tile" ' + tileAttrs
                + ' data-path="' + window.stataUI.escapeHtml(a.path || '') + '"'
                + ' data-basedir="' + window.stataUI.escapeHtml(a.baseDir || '') + '"'
                + ' data-label="' + label + '"'
                + ' data-index="' + idx + '">' 
                +   '<div class="artifact-thumb">' + thumbHtml + '</div>'
                +   '<div class="artifact-tile-label" title="' + label + '">' + label + '</div>'
                +   errorHtml
                + '</div>'
            );
        }).join('');

        return (
            '<section class="artifacts-card" data-artifacts-id="' + artifactsId + '" data-collapsed="' + (isCollapsed ? 'true' : 'false') + '">' 
            + '<header class="artifacts-header">'
            +   '<div class="artifacts-title">Artifacts</div>'
            +   '<div class="artifacts-header-right">'
            +     '<span class="artifacts-count">' + artifacts.length + '</span>'
            +     '<button class="artifacts-toggle" type="button" data-action="toggle-artifacts" data-artifacts-id="' + artifactsId + '">' + (isCollapsed ? 'Show' : 'Hide') + '</button>'
            +   '</div>'
            + '</header>'
            + '<div class="artifacts-body ' + (isCollapsed ? 'hidden' : '') + '" data-artifacts-body="' + artifactsId + '">' 
            +   '<div class="artifact-gallery">' + tiles + '</div>'
            + '</div>'
            + '</section>'
        );
    }

    const collapsedArtifacts = Object.create(null);

    const modal = document.getElementById('artifact-modal');
    const modalTitle = document.getElementById('artifact-modal-title');
    const modalImg = document.getElementById('artifact-modal-img');
    const modalMeta = document.getElementById('artifact-modal-meta');
    const modalOpenBtn = document.getElementById('artifact-modal-open');
    const modalRevealBtn = document.getElementById('artifact-modal-reveal');
    const modalCopyBtn = document.getElementById('artifact-modal-copy');
    const modalDownloadBtn = document.getElementById('artifact-modal-download');
    let activeModalArtifact = null;

    function openArtifactModal(artifact) {
        activeModalArtifact = artifact;
        if (modalTitle) modalTitle.textContent = artifact.label || 'Graph';
        if (modalImg) {
            modalImg.src = artifact.src || '';
            modalImg.alt = artifact.label || 'Graph';
        }
        if (modalMeta) {
            modalMeta.textContent = artifact.path || '';
        }
        if (modalDownloadBtn) {
            // Enable download button if we have a graph name
            const ok = artifact.label || artifact.name;
            modalDownloadBtn.disabled = !ok;
            modalDownloadBtn.style.opacity = ok ? '1' : '0.6';
        }
        if (modal) {
            modal.classList.remove('hidden');
            modal.setAttribute('aria-hidden', 'false');
        }
    }

    function closeArtifactModal() {
        activeModalArtifact = null;
        if (modal) {
            modal.classList.add('hidden');
            modal.setAttribute('aria-hidden', 'true');
        }
        if (modalImg) modalImg.src = '';
    }

    // Download button handler - requests PDF export and downloads it
    if (modalDownloadBtn) {
        modalDownloadBtn.addEventListener('click', async () => {
            console.log('[Modal] Download button clicked');
            
            if (!activeModalArtifact) {
                console.error('[Modal] No active artifact');
                return;
            }
            
            const graphName = activeModalArtifact.label || activeModalArtifact.name;
            console.log('[Modal] Graph name:', graphName);
            
            if (!graphName) {
                console.error('[Modal] No graph name found');
                return;
            }
            
            try {
                const originalText = modalDownloadBtn.textContent;
                modalDownloadBtn.disabled = true;
                modalDownloadBtn.textContent = 'Downloading...';
                
                console.log('[Modal] Sending download-graph-pdf message:', graphName);
                
                // Request PDF export from the extension
                vscode.postMessage({
                    command: 'download-graph-pdf',
                    graphName: graphName
                });
                
                console.log('[Modal] Message sent successfully');
                
                // Reset button after a delay
                setTimeout(() => {
                    modalDownloadBtn.disabled = false;
                    modalDownloadBtn.textContent = originalText;
                    console.log('[Modal] Button reset');
                }, 3000);
            } catch (err) {
                console.error('[Modal] Download error:', err);
                modalDownloadBtn.disabled = false;
                modalDownloadBtn.textContent = 'Download PDF';
                alert('Download failed: ' + err.message);
            }
        });
    }

    // Close modal on overlay click
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal || e.target.classList.contains('artifact-modal-overlay')) {
                closeArtifactModal();
            }
        });
    }

    // Close on escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
            closeArtifactModal();
        }
    });

    console.log('[Modal] Modal script loaded, vscode API:', typeof vscode);    

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'cleared') {
          clearAllOutput();
          setBusy(false);
          return;
      }

      if (msg.type === 'init') {
          // Legacy init support if needed, but we prefer embedded
          if (msg.history) msg.history.forEach(appendEntry);
      }
      if (msg.type === 'append') {
        appendEntry(msg.entry);
      }
      if (msg.type === 'busy') setBusy(msg.value);

      if (msg.type === 'datasetSummary') {
        if (dataSummary && obsCount && varCount) {
            if (msg.n === 0 && msg.k === 0) {
                dataSummary.style.display = 'none';
            } else {
                dataSummary.style.display = 'flex';
                obsCount.textContent = (msg.n || 0).toLocaleString();
                varCount.textContent = (msg.k || 0).toLocaleString();
            }
        }
      }

      if (msg.type === 'runStarted') {
        const runId = msg.runId;
        const code = String(msg.code || '');
        ensureRunGroup(runId, code);
        updateStatusIndicator(null, null); // Reset status when run starts
      }

      if (msg.type === 'runCancelled') {
        const runId = msg.runId;
        const run = runs[runId];
        if (!run) return;
        if (run.statusDot) run.statusDot.style.color = 'var(--accent-warning)';
        if (run.statusTitle) run.statusTitle.textContent = 'Stata Output (cancelled)';
        if (run.stderrEl) {
            run.stderrEl.style.display = 'block';
            run.stderrEl.innerHTML = String(msg.message || 'Run cancelled.');
        }
        if (run.progressWrap) {
            if (run.progressText) run.progressText.textContent = '';
            if (run.progressMeta) run.progressMeta.textContent = '';
        }
        // Update header status for cancelled
        updateStatusIndicator(false, null);
        if (autoScrollPinned) scrollToBottomSmooth();
      }

      if (msg.type === 'downloadStatus') {
        // Reset modal download button state
        if (modalDownloadBtn) {
          modalDownloadBtn.disabled = false;
          modalDownloadBtn.textContent = 'Download PDF';
        }
        if (!msg.success && msg.message) {
          console.error('[Modal] Download failed:', msg.message);
        }
      }

      if (msg.type === 'runLogAppend') {
        const runId = msg.runId;
        const run = runs[runId];
        if (!run || !run.stdoutEl) return;
        const shouldStick = autoScrollPinned;
        const chunk = String(msg.text ?? '');
        if (!chunk) return;
        const MAX_STREAM_CHARS = 20_000; // keep a bounded tail while streaming
        run.stdoutEl.insertAdjacentHTML('beforeend', chunk);
        
        scheduleHighlight();
        const currentLen = run.stdoutEl.innerHTML.length;
        if (currentLen > MAX_STREAM_CHARS) {
            run.stdoutEl.innerHTML = safeSliceTail(run.stdoutEl.innerHTML, MAX_STREAM_CHARS);
        }
        if (shouldStick) scheduleScrollToBottom();
      }

      if (msg.type === 'runProgress') {
        const runId = msg.runId;
        const run = runs[runId];
        if (!run) return;
        const progress = msg.progress;
        const total = msg.total;
        const message = msg.message;
        if (run.progressWrap) run.progressWrap.style.display = 'block';
        if (run.progressText) run.progressText.textContent = message ? String(message) : '';
        let pct = null;
        if (typeof progress === 'number' && typeof total === 'number' && total > 0) {
            pct = Math.max(0, Math.min(100, (progress / total) * 100));
            if (run.progressMeta) run.progressMeta.textContent = String(progress) + '/' + String(total);
        } else if (typeof progress === 'number') {
            if (run.progressMeta) run.progressMeta.textContent = String(progress);
        } else {
            if (run.progressMeta) run.progressMeta.textContent = '';
        }
        if (run.progressFill) {
            run.progressFill.style.width = pct == null ? '0%' : (pct.toFixed(0) + '%');
        }
      }

      if (msg.type === 'runFinished') {
        const runId = msg.runId;
        const run = runs[runId];
        if (!run) return;

        const success = msg.success === true;
        const hasError = msg.hasError === true;
        
        // Determine traffic light color based on success
        if (run.statusDot) {
            run.statusDot.style.color = success ? 'var(--accent-success)' : 'var(--accent-error)';
        }
        
        if (run.statusTitle) {
            run.statusTitle.textContent = 'Stata Output';
        }

        if (run.rcEl) {
            run.rcEl.textContent = (msg.rc !== null && msg.rc !== undefined) ? ('RC ' + String(msg.rc)) : '';
        }
        if (run.durationEl) {
            run.durationEl.textContent = msg.durationMs ? window.stataUI.formatDuration(msg.durationMs) : '';
        }

        // Populate Log tab
        if (run.logEl) {
            run.logEl.innerHTML = String(msg.fullStdout || '');
        }

        // Show tabs ONLY if there was an error or a non-zero RC
        if (run.tabsContainer) {
            const hasProblem = !success || hasError || (msg.rc !== null && msg.rc !== 0);
            run.tabsContainer.style.display = hasProblem ? 'flex' : 'none';
        }

        const stderr = String(msg.stderr || '');
        if (stderr && run.stderrEl) {
            run.stderrEl.style.display = 'block';
            run.stderrEl.innerHTML = stderr;
        } else if (!success && run.stderrEl) {
            const fallback = msg.rc != null ? ('Run failed (RC ' + msg.rc + ')') : 'Run failed';
            run.stderrEl.style.display = 'block';
            run.stderrEl.innerHTML = fallback;
        }

        // If the run failed, prioritize showing the error and hide the bulky stdout content.
        // When successful, only backfill stdout when it is small or the delta is small to avoid massive reflows.
        const finalStdout = String(msg.stdout || '');
        const MAX_STDOUT_DISPLAY = 20_000; // show at most the tail of large stdout
        const MAX_BACKFILL_DELTA = 5_000; // avoid replacing huge content if streaming already filled most
        if (!success && run.stdoutEl) {
            // Only overwrite if we have actual final output to show.
            // If finalStdout is empty (e.g. error preventing capture), keep any partial streamed output.
            if (finalStdout) {
                const tail = safeSliceTail(finalStdout, MAX_STDOUT_DISPLAY);
                run.stdoutEl.innerHTML = tail;
                run.stdoutEl.style.display = tail ? 'block' : 'none';
            } else if (run.stdoutEl.innerHTML) {
                // Keep existing streamed content visible
                run.stdoutEl.style.display = 'block';
            }
        } else if (run.stdoutEl && finalStdout) {
            const current = run.stdoutEl.innerHTML || '';
            const normalizedFinal = safeSliceTail(finalStdout, MAX_STDOUT_DISPLAY);

            const needsInitial = !current && normalizedFinal;
            const needsSmallDelta = normalizedFinal.length > current.length &&
                (normalizedFinal.length - current.length) <= MAX_BACKFILL_DELTA;

            if (needsInitial || needsSmallDelta) {
                run.stdoutEl.innerHTML = normalizedFinal;
            } else if (!current && normalizedFinal) {
                // Fallback: if we had no streaming but have results, show them
                run.stdoutEl.innerHTML = normalizedFinal;
            }
            if (run.stdoutEl.innerHTML) {
                run.stdoutEl.style.display = 'block';
            }
        }

        if (run.progressWrap) {
            // Keep progress visible if it was ever shown, but it is now final.
            if (run.progressText) run.progressText.textContent = '';
            if (run.progressMeta) run.progressMeta.textContent = '';
        }

        const artifactsHtml = renderArtifacts(msg.artifacts, runId);
        if (run.artifactsEl) {
            run.artifactsEl.innerHTML = artifactsHtml;
        }
        
        // Update header status indicator
        updateStatusIndicator(success, msg.rc);
        setBusy(false);

        if (autoScrollPinned) scrollToBottomSmooth();
      }

      if (msg.type === 'runFailed') {
        const runId = msg.runId;
        const run = runs[runId];
        if (!run) return;
        if (run.statusDot) run.statusDot.style.color = 'var(--accent-error)';
        if (run.statusTitle) run.statusTitle.textContent = 'Stata Output (failed)';
        if (run.stderrEl) {
            run.stderrEl.style.display = 'block';
            run.stderrEl.textContent = String(msg.message || 'Unknown error');
        }
        
        // Update header status for failed run
        updateStatusIndicator(false, null);
        setBusy(false);

        if (autoScrollPinned) scrollToBottomSmooth();
      }

      if (msg.type === 'variables') {
        variablesPending = false;
        const incoming = Array.isArray(msg.variables) ? msg.variables : [];
        variables.length = 0;
        incoming.forEach((v) => {
            if (typeof v === 'string') {
                variables.push(v);
                return;
            }
            if (v && typeof v === 'object' && v.name) {
                variables.push(v.name);
            }
        });
        lastCompletion = null;
      }

      if (msg.type === 'error') {
        const div = document.createElement('div');
        div.className = 'message-group';
        div.innerHTML = '<div class="system-bubble"><div class="output-content error">' + window.stataUI.escapeHtml(msg.message) + '</div></div>';
        chatStream.appendChild(div);
        setBusy(false);
        const lastGroup = chatStream.lastElementChild;
         if (lastGroup && lastGroup.dataset.optimistic) {
            lastGroup.remove();
        }
      }
    });

    // Render initial entries if any
    try {
        initialEntries.forEach(appendEntry);
        // Notify ready
        vscode.postMessage({ type: 'ready' });
      requestVariables();
    } catch (err) {
        console.error('Failed to render initial entries', err);
        vscode.postMessage({ type: 'log', level: 'error', message: err.message });
    }

    // Dynamic spacer for fixed input area
    const inputArea = document.querySelector('.input-area');
    const spacer = document.createElement('div');
    spacer.id = 'bottom-spacer';
    document.body.appendChild(spacer);

    function updateSpacer() {
        if (inputArea) {
            const height = inputArea.offsetHeight;
            // Height + bottom offset (24px) + buffer (30px)
            spacer.style.height = (height + 15) + 'px';
            spacer.style.width = '100%';
        }
    }
    
    // Update on load, resize, and input change
    updateSpacer();
    // Force scroll to bottom after initial layout
    setTimeout(() => {
        autoScrollPinned = true;
        scrollToBottom();
    }, 50);

    window.addEventListener('scroll', () => {
        autoScrollPinned = isAtBottom();
    }, { passive: true });

    document.addEventListener('click', (e) => {
        const toggle = e.target.closest('[data-action="toggle-artifacts"]');
        if (toggle) {
            const id = toggle.getAttribute('data-artifacts-id');
            if (!id) return;
            const body = document.querySelector('[data-artifacts-body="' + CSS.escape(id) + '"]');
            const card = document.querySelector('[data-artifacts-id="' + CSS.escape(id) + '"]');
            const collapsed = !(collapsedArtifacts[id] === true);
            collapsedArtifacts[id] = collapsed;
            if (body) body.classList.toggle('hidden', collapsed);
            if (card) card.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
            toggle.textContent = collapsed ? 'Show' : 'Hide';
            return;
        }

        const preview = e.target.closest('[data-action="preview-graph"]');
        if (preview) {
            const src = preview.getAttribute('data-src') || '';
            const path = preview.getAttribute('data-path') || '';
            const baseDir = preview.getAttribute('data-basedir') || '';
            const label = preview.getAttribute('data-label') || 'Graph';
            openArtifactModal({ src, path, baseDir, label });
            return;
        }

        const close = e.target.closest('[data-action="close-artifact-modal"]');
        if (close) {
            closeArtifactModal();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
            closeArtifactModal();
        }
    });

    if (modalOpenBtn) {
        modalOpenBtn.addEventListener('click', () => {
            if (!activeModalArtifact) return;
            vscode.postMessage({
                type: 'openArtifact',
                path: activeModalArtifact.path,
                baseDir: activeModalArtifact.baseDir,
                label: activeModalArtifact.label
            });
        });
    }

    if (modalRevealBtn) {
        modalRevealBtn.addEventListener('click', () => {
            if (!activeModalArtifact) return;
            vscode.postMessage({
                type: 'revealArtifact',
                path: activeModalArtifact.path,
                baseDir: activeModalArtifact.baseDir,
                label: activeModalArtifact.label
            });
        });
    }

    if (modalCopyBtn) {
        modalCopyBtn.addEventListener('click', () => {
            if (!activeModalArtifact) return;
            vscode.postMessage({
                type: 'copyArtifactPath',
                path: activeModalArtifact.path,
                baseDir: activeModalArtifact.baseDir,
                label: activeModalArtifact.label
            });
        });
    }

    if (modalDownloadBtn) {
        modalDownloadBtn.addEventListener('click', () => {
            if (!activeModalArtifact) return;
            const graphName = activeModalArtifact.label || activeModalArtifact.name || 'graph';
            vscode.postMessage({
                command: 'download-graph-pdf',
                graphName
            });
        });
    }

    window.addEventListener('resize', () => {
        updateSpacer();
        if (autoScrollPinned) scrollToBottom();
    });
    
    input.addEventListener('input', () => {
        // Allow resize to happen first
        setTimeout(() => {
            updateSpacer();
            if (autoScrollPinned) scrollToBottom(); // Keep bottom visible when typing
        }, 0);
    });
    
    // Also update when content changes
    const observer = new MutationObserver(() => {
        updateSpacer();
    });
    if (inputArea) {
        observer.observe(inputArea, { attributes: true, childList: true, subtree: true });
    }

    function isAtBottom() {
        return (window.innerHeight + window.scrollY) >= document.body.offsetHeight - 50;
    }

    setBusy(false);
    requestVariables();

    function handleTabCompletion() {
      if (!variables.length) {
        requestVariables();
        return false;
      }

      const token = currentToken();
      if (!token) return false;

      const names = variables.filter(Boolean);
      const matches = names.filter((name) => name.toLowerCase().startsWith(token.prefix.toLowerCase()));
      if (!matches.length) return false;

      if (!lastCompletion || lastCompletion.prefix !== token.prefix || lastCompletion.start !== token.start || lastCompletion.end !== token.end) {
        lastCompletion = { prefix: token.prefix, start: token.start, end: token.end, index: 0, matches };
      } else {
        lastCompletion.index = (lastCompletion.index + 1) % matches.length;
      }

      const replacement = matches[lastCompletion.index];
      applyReplacement(token.start, token.end, replacement);
      return true;
    }

    function currentToken() {
      const pos = input.selectionStart;
      if (pos === null || pos === undefined) return null;
      const text = input.value;
      const before = text.slice(0, pos);
      const beforeMatch = before.match(/([A-Za-z0-9_\.]+)$/);
      if (!beforeMatch) return null;
      const prefix = beforeMatch[1];
      const start = pos - prefix.length;
      const after = text.slice(pos);
      const afterMatch = after.match(/^([A-Za-z0-9_\.]+)/);
      const end = pos + (afterMatch ? afterMatch[1].length : 0);
      if (!prefix) return null;
      return { prefix, start, end };
    }

    function applyReplacement(start, end, replacement) {
      const value = input.value;
      input.value = value.slice(0, start) + replacement + value.slice(end);
      const cursor = start + replacement.length;
      input.setSelectionRange(cursor, cursor);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  </script>
</body>
</html>`;
}

function toEntry(code, result) {
  // Parse SMCL stderr to extract RC and format
  let finalRC = typeof result?.rc === 'number' ? result.rc : null;
  let finalStderr = result?.stderr || '';

  // Search for context (Commands, call stacks, etc.) in both stdout and stderr.
  // This is crucial for do-files where commands are in stdout but errors are in stderr.
  const combinedOutput = (result?.stdout || '') + '\n' + (result?.stderr || '');
  const parsed = parseSMCL(combinedOutput);

  if (parsed.rc !== null) {
    finalRC = parsed.rc;
  }

  if (finalRC === -1 || finalRC === null) {
    // Extra fallback for unrecognized command pattern
    if (combinedOutput.includes('unrecognized command') || combinedOutput.includes('is unrecognized')) {
      finalRC = 199;
    }
  }

  if (parsed.formattedText) {
    const smclContext = parsed.formattedText
      .split('\n')
      .map(line => {
        if (line.startsWith('In:') || line.startsWith('Command:')) {
          return `{txt}${line}`;
        }
        if (line.startsWith('Error:')) {
          return `{err}${line}`;
        }
        return `{txt}${line}`;
      })
      .join('\n');

    if (finalStderr) {
      // Separate context from raw output with a horizontal line
      finalStderr = `${smclContext}\n{res}{hline}\n${finalStderr}`;
    } else {
      finalStderr = smclContext;
    }
  }

  // Determine success using parsed RC
  const success = determineSuccess(result, finalRC);

  let stdout = success ? (result?.stdout || result?.contentText || '') : '';
  let stderr = success ? '' : finalStderr;

  // Process SMCL for history entries
  stdout = stdout ? smclToHtml(stdout) : '';
  stderr = stderr ? smclToHtml(stderr) : '';

  // Return the complete entry object
  return {
    code,
    success,
    hasError: parsed.hasError,
    rc: finalRC,
    durationMs: result?.durationMs ?? null,
    stdout,
    fullStdout: smclToHtml(result?.stdout || result?.contentText || ''),
    stderr,
    artifacts: normalizeArtifacts(result),
    timestamp: Date.now()
  };
}

/**
 * Normalizes artifact objects for display in the terminal panel.
 * The `previewDataUri` field is generated by the extension (mcp-client) from a local file path
 * to provide a base64 preview for the UI. This base64 data is NOT exposed to AI agents
 * as part of tool outputs, ensuring token efficiency.
 * @param {object} result
 * @returns {Array<object>}
 */
function normalizeArtifacts(result) {
  const preferred = Array.isArray(result?.graphArtifacts)
    ? result.graphArtifacts
    : (result?.artifacts || []);
  if (!Array.isArray(preferred)) return [];
  const normalized = preferred.map((a) => {
    if (!a) return null;
    const label = a.label || path.basename(a.path || '') || 'artifact';
    const dataUri = a.dataUri && typeof a.dataUri === 'string' ? a.dataUri : null;
    const baseDir = a.baseDir || result?.cwd || (result?.filePath ? path.dirname(result.filePath) : null);
    return {
      label,
      path: a.path || a.dataUri || '',
      dataUri,
      previewDataUri: a.previewDataUri || null,
      error: a.error || null,
      baseDir
    };
  }).filter(Boolean);

  const counts = Object.create(null);
  for (const a of normalized) {
    const k = a.label || 'artifact';
    counts[k] = (counts[k] || 0) + 1;
  }

  const seen = Object.create(null);
  for (const a of normalized) {
    const k = a.label || 'artifact';
    if ((counts[k] || 0) > 1) {
      seen[k] = (seen[k] || 0) + 1;
      a.label = k + ' (' + String(seen[k]) + ')';
    }
  }

  return normalized;
}

function determineSuccess(result, finalRC) {
  if (!result) return false;

  // If we have a parsed RC, use that FIRST (takes precedence)
  if (typeof finalRC === 'number') {
    // Normal RCs (not errors):
    // 0 = success
    // User explicitly requested to treat 1, 9, 10 as errors (remove "amber" logic).
    const isNormalRC = finalRC === 0;
    return isNormalRC;
  }

  // Fall back to result flags only when we don't have a parsed RC
  if (result.success === false) return false;
  if (result.error) return false;

  return true;
}
function escapeHtml(text) {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}


function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}