const { openArtifact, revealArtifact, copyToClipboard, resolveArtifactUri } = require('./artifact-utils');
const Sentry = require("@sentry/node");
const path = require('path');
const os = require('os');
const vscode = require('vscode');
const fs = require('fs');
const { filterMcpLogs } = require('./log-utils');
const { getTmpDir } = require('./fs-utils');
/**
 * Parse SMCL text and extract formatted error information
 * @param {string} smclText -Raw SMCL text
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
  static _cancelTaskHandler = null;
  static _clearHandler = null;
  static _activeRunId = null;
  static _activeFilePath = null;
  static _webviewReady = true;
  static _pendingWebviewMessages = [];
  static _panelInstanceId = 0;

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
   * @param {(runId: string) => Promise<void>} [options.cancelTask]
   * @param {() => Promise<void>} [options.clearAll]
   */
  static show({ filePath, initialCode, initialResult, runCommand, variableProvider, downloadGraphPdf, cancelRun, cancelTask, clearAll }) {
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
    if (typeof cancelTask === 'function') {
      TerminalPanel._cancelTaskHandler = cancelTask;
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
            vscode.Uri.joinPath(TerminalPanel.extensionUri, 'src', 'ui-shared'),
            vscode.Uri.joinPath(TerminalPanel.extensionUri, 'dist', 'ui-shared'),
            vscode.Uri.file(getTmpDir())
          ]
        }
      );
      TerminalPanel._panelInstanceId += 1;
      TerminalPanel.currentPanel.__stataPanelId = TerminalPanel._panelInstanceId;

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


        if (message.type === 'run' && typeof message.code === 'string') {
          await TerminalPanel.handleRun(message.code, runCommand);
        }
        if ((message.command === 'download-graph-pdf' || message.type === 'downloadGraphPdf') && message.graphName) {
          await TerminalPanel._handleDownloadGraphPdf(message.graphName);
        }
        if (message.type === 'cancelRun') {
          await TerminalPanel._handleCancelRun();
        }
        if (message.type === 'cancelTask' && message.runId) {
          await TerminalPanel._handleCancelTask(message.runId);
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
          if (message.level === 'error') {
            Sentry.captureException(new Error(`Webview Error: ${message.message}`));
          }
          console.log(`[Client Log] ${message.level || 'info'}: ${message.message}`);
        }
        if (message.type === 'fetchLog') {
          await TerminalPanel._handleFetchLog(message.runId, message.path, message.offset, message.maxBytes);
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
      if (msg && msg.type && msg.type !== 'runLogAppend') {
      }
      return;
    }
    if (msg && (msg.type === 'taskDoneOutput' || msg.type === 'runFinished')) {
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
    return Sentry.startSpan({ name: 'terminal.handleRun', op: 'extension.operation' }, async () => {
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
          runId,
          onLog: (text) => {
            if (!text) return;
            TerminalPanel._postMessage({ type: 'runLogAppend', runId, text: formatStreamChunk(text), streamFormat: 'plain' });
          },
          onProgress: (progress, total, message) => {
            TerminalPanel._postMessage({ type: 'runProgress', runId, progress, total, message });
          },
          onTaskDone: (payload) => {
            let stdout = null;
            if (payload?.logPath) {
              try {
                const stats = fs.statSync(payload.logPath);
                if (stats.size > 0 && stats.size <= 50000) {
                  stdout = fs.readFileSync(payload.logPath, 'utf8');
                }
              } catch (_err) {
              }
            }
            TerminalPanel.notifyTaskDone(runId, payload?.logPath, payload?.logSize, stdout, payload?.rc);
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
          stdout: success ? (result?.stdout || result?.contentText || '') : '',
          // fullStdout: always available for the 'Log' tab.
          fullStdout: (result?.stdout || result?.contentText || ''),
          stderr: success ? '' : finalStderr,
          artifacts: normalizeArtifacts(result),
          baseDir: result?.cwd || ''
        });
      } catch (error) {
        TerminalPanel._postMessage({ type: 'runFailed', runId, message: error?.message || String(error) });
      } finally {
        TerminalPanel._activeRunId = null;
        TerminalPanel._postMessage({ type: 'busy', value: false });
      }
    });
  }

  static async _handleDownloadGraphPdf(graphName) {
    return Sentry.startSpan({ name: 'terminal.downloadGraphPdf', op: 'extension.operation' }, async () => {
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
    });
  }

  static async _handleCancelRun() {
    return Sentry.startSpan({ name: 'terminal.cancelRun', op: 'extension.operation' }, async () => {
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
    });
  }

  static async _handleCancelTask(runId) {
    return Sentry.startSpan({ name: 'terminal.cancelTask', op: 'extension.operation' }, async () => {
      if (typeof TerminalPanel._cancelTaskHandler === 'function') {
        try {
          await TerminalPanel._cancelTaskHandler(runId);
        } catch (error) {
          console.error('[TerminalPanel] cancelTask failed:', error);
        }
      }
    });
  }

  static startStreamingEntry(code, filePath, runCommand, variableProvider, cancelRun, cancelTask, downloadGraphPdf) {
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
    if (typeof cancelTask === 'function') {
      TerminalPanel._cancelTaskHandler = cancelTask;
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
        cancelTask: TerminalPanel._cancelTaskHandler,
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

  static updateStreamingStatus(runId, status) {
    if (!TerminalPanel.currentPanel || !runId) return;
    TerminalPanel._postMessage({ type: 'runStatusUpdate', runId, status });
  }

  static appendStreamingLog(runId, text) {
    if (!TerminalPanel.currentPanel || !runId) return;
    const chunk = String(text ?? '');
    if (!chunk) return;
    TerminalPanel._postMessage({ type: 'runLogAppend', runId, text: formatStreamChunk(chunk), streamFormat: 'plain' });
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

    if (parsed.formattedText) {
      finalStderr = parsed.formattedText;
    }

    // NOW determine success using the parsed RC
    const success = determineSuccess(result, finalRC);

    let logSize = 0;
    if (result?.logPath) {
      try {
        const stats = fs.statSync(result.logPath);
        logSize = stats.size;
      } catch (e) {
        if (e.code !== 'ENOENT') {
          console.error('Failed to stat log file:', e);
        }
      }
    }

    TerminalPanel._postMessage({
      type: 'runFinished',
      runId,
      rc: finalRC,
      success,
      durationMs: result?.durationMs ?? null,
      // Apply smclToHtml to the final result
      stdout: success ? (result?.stdout || result?.contentText || '') : '',
      fullStdout: result?.stdout || result?.contentText || '',
      stderr: success ? '' : finalStderr,
      logPath: result?.logPath || null,
      logSize,
      artifacts: normalizeArtifacts(result),
      baseDir: result?.cwd || ''
    });
    TerminalPanel._postMessage({ type: 'busy', value: false });
  }

  static notifyTaskDone(runId, logPath, logSize, stdout, rc) {
    if (!TerminalPanel.currentPanel || !runId) return;
    TerminalPanel._postMessage({
      type: 'taskDone',
      runId,
      logPath: logPath || null,
      logSize: logSize ?? null,
      stdout: stdout || null,
      rc: rc ?? null
    });
  }

  static appendRunArtifact(runId, artifact) {
    if (!TerminalPanel.currentPanel || !runId || !artifact) return;
    const webview = TerminalPanel.currentPanel.webview;
    const baseDir = artifact.baseDir || null;
    const resolved = artifact.path ? resolveArtifactUri(artifact.path, baseDir) : null;
    const previewPath = (webview && resolved && resolved.scheme === 'file' && resolved.fsPath.toLowerCase().endsWith('.svg'))
      ? webview.asWebviewUri(resolved).toString()
      : null;
    if (previewPath) {
      console.log('[TerminalPanel] SVG previewPath', previewPath);
    } else if (artifact.path) {
      console.log('[TerminalPanel] No previewPath for', artifact.path);
    }
    TerminalPanel._postMessage({
      type: 'runArtifact',
      runId,
      artifact: { ...artifact, previewPath }
    });
  }

  static async _handleFetchLog(runId, path, offset, maxBytes) {
    return Sentry.startSpan({ name: 'terminal.fetchLog', op: 'extension.operation' }, async () => {
      console.log(`[TerminalPanel] _handleFetchLog: runId=${runId} path=${path} offset=${offset}`);
      if (!path) return;
      if (offset === 0) {
      }
      try {
        // Lazy require to avoid circularity if possible, or assume mcpClient is globally available 
        if (TerminalPanel._logProvider) {
          const slice = await TerminalPanel._logProvider(path, offset, maxBytes);
          const rawData = slice?.data || '';

          TerminalPanel._postMessage({
            type: 'logChunk',
            runId,
            path,
            offset,
            data: rawData,
            nextOffset: slice?.next_offset
          });
        }
      } catch (err) {
        Sentry.captureException(err);
        console.error('Fetch log failed', err);
      }
    });
  }

  static setLogProvider(fn) {
    TerminalPanel._logProvider = fn;
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
   * @param {string} [filePath] -associated file path to update title if needed
   * @param {(code: string) => Promise<object>} [runCommand] -command runner if panel needs initialization
   */
  static addEntry(code, result, filePath, runCommand, variableProvider) {
    return Sentry.startSpan({ name: 'terminal.addEntry', op: 'extension.ui' }, () => {
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
    });
  }

  static async _handleClearAll() {
    return Sentry.startSpan({ name: 'terminal.clearAll', op: 'extension.operation' }, async () => {
      if (typeof TerminalPanel._clearHandler === 'function') {
        try {
          // Clear UI first, before running command
          TerminalPanel._postMessage({ type: 'cleared' });
          TerminalPanel._postMessage({ type: 'busy', value: true });
          await TerminalPanel._clearHandler();
          // Success -UI already cleared, no need to show anything
        } catch (error) {
          Sentry.captureException(error);
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
    });
  }

}

module.exports = { TerminalPanel, toEntry, normalizeArtifacts, parseSMCL, determineSuccess };

function renderHtml(webview, extensionUri, nonce, filePath, initialEntries = []) {
  const designUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'design.css'));
  const highlightCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'highlight.css'));
  const mainJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'ui-shared', 'main.js'));
  const highlightJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'highlight.min.js'));
  const markJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ui-shared', 'mark.min.js'));

  const fileName = filePath ? path.basename(filePath) : 'Terminal Session';
  const escapedTitle = escapeHtml(fileName);
  const initialJson = JSON.stringify(initialEntries).replace(/</g, '\\u003c');

  // CSP: Allow scripts, styles, and connect to localhost (for API) + Sentry
  const csp = `
    default-src 'none'; 
    img-src ${webview.cspSource} https: data:; 
    script-src 'nonce-${nonce}' ${webview.cspSource} blob:; 
    worker-src 'self' blob:;
    style-src 'unsafe-inline' ${webview.cspSource} https://unpkg.com; 
    font-src ${webview.cspSource} https://unpkg.com; 
    connect-src ${webview.cspSource} http://127.0.0.1:* https://o4510744386732032.ingest.de.sentry.io;
  `.replace(/\s+/g, ' ').trim();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${designUri}">
  <link rel="stylesheet" href="${highlightCssUri}">
  <link rel="stylesheet" href="https://unpkg.com/@vscode/codicons@0.0.44/dist/codicon.css">
  <title>Stata Terminal</title>
  <script nonce="${nonce}">
    window.initialEntries = ${initialJson};
  </script>
  <style nonce="${nonce}">
    /* Override highlight.js background to blend with terminal */
    .hljs { background: transparent !important; padding: 0 !important; }

    .context-right .btn-icon {
      padding: 4px;
      height: 28px;
      width: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .context-right .btn-icon i {
      font-size: 16px;
      line-height: 1;
      display: block;
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

    .btn-xs {
      padding: 2px 4px;
      height: 20px;
      min-width: 20px;
      font-size: 10px;
    }

    .cancel-queued-btn {
      color: var(--text-muted);
      margin-left: 4px;
      display: inline-flex;
    }

    .cancel-queued-btn:hover {
      color: var(--accent-error);
    }
  </style>
</head>
<body>

  <!--Context Header -->
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
        <!-- <button class="btn btn-ghost btn-icon" id="btn-show-graphs" title="Show Graphs">
          <i class="codicon codicon-graph"></i>
        </button> -->
      </div>
    </div>
  </div>

  <main class="chat-stream" id="chat-stream">
    <div id="session-artifacts"></div>
    <!--Entries injected here -->
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

  <!--Floating Input Area -->
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
  <script src="${markJsUri}"></script>
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
                const rem = s -m * 60;
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
    let highlightScheduled = 0;
    function scheduleHighlight() {
        if (highlightTimer) return;
        highlightScheduled += 1;
        console.log('[Highlight] scheduled ' + highlightScheduled);
        highlightTimer = requestAnimationFrame(() => {
            const start = Date.now();
            if (window.stataUI && window.stataUI.processSyntaxHighlighting) {
                window.stataUI.processSyntaxHighlighting();
            }
            const elapsed = Date.now() - start;
            console.log('[Highlight] ran in ' + elapsed + 'ms');
            highlightTimer = null;
        });
    }
    
    // Initial load
    document.addEventListener('DOMContentLoaded', () => {
        if (window.stataUI && window.stataUI.processSyntaxHighlighting) {
            window.stataUI.processSyntaxHighlighting();
        }
    });

    const taskDoneRuns = new Set();
    
    const chatStream = document.getElementById('chat-stream');
    const originalConsole = {
        log: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console)
    };
    const forwardConsole = (level, args) => {
        try {
            const message = args.map(arg => {
                if (typeof arg === 'string') return arg;
                try {
                    return JSON.stringify(arg);
                } catch (_err) {
                    return String(arg);
                }
            }).join(' ');
            vscode.postMessage({ type: 'log', level, message });
        } catch (_err) {
        }
    };
    console.log = (...args) => {
        originalConsole.log(...args);
        forwardConsole('info', args);
    };
    console.warn = (...args) => {
        originalConsole.warn(...args);
        forwardConsole('warn', args);
    };
    console.error = (...args) => {
        originalConsole.error(...args);
        forwardConsole('error', args);
    };
    window.addEventListener('error', (event) => {
        forwardConsole('error', [event?.message || 'Webview error', event?.filename, event?.lineno, event?.colno]);
    });
    const input = document.getElementById('command-input');
    const runBtn = document.getElementById('run-btn');
    const stopBtn = document.getElementById('stop-btn');
    const clearBtn = document.getElementById('clear-btn');
    const btnOpenBrowser = document.getElementById('btn-open-browser');
    const dataSummary = document.getElementById('data-summary');
    const obsCount = document.getElementById('obs-count');
    const varCount = document.getElementById('var-count');
    
    if (btnOpenBrowser) {
        btnOpenBrowser.addEventListener('click', () => {
            vscode.postMessage({ type: 'openDataBrowser' });
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
    const runMetrics = Object.create(null);
    const sessionArtifacts = [];
    const sessionArtifactKeys = new Set();
    const sessionArtifactsEl = document.getElementById('session-artifacts');

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

        sessionArtifacts.length = 0;
        sessionArtifactKeys.clear();
        if (sessionArtifactsEl) {
            sessionArtifactsEl.innerHTML = '';
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
        
        const firstNewline = html.indexOf(String.fromCharCode(10), start);
        const firstHtmlTag = html.indexOf('<', start);
        const firstSmclTag = html.indexOf('{', start);
        
        let cutPoint = -1;
        let offset = 0;

        const candidates = [];
        if (firstNewline !== -1) candidates.push({ pos: firstNewline, offset: 1 });
        if (firstHtmlTag !== -1) candidates.push({ pos: firstHtmlTag, offset: 0 });
        if (firstSmclTag !== -1) candidates.push({ pos: firstSmclTag, offset: 0 });

        if (candidates.length > 0) {
            candidates.sort((a, b) => a.pos - b.pos);
            cutPoint = candidates[0].pos;
            offset = candidates[0].offset;
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

        const easeOutCubic = (t) => 1 -Math.pow(1 -t, 3);

        const step = (now) => {
            const tNow = now ?? ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());
            const elapsed = tNow -startTime;
            const t = Math.max(0, Math.min(1, elapsed / durationMs));
            const eased = easeOutCubic(t);

            const targetY = document.body.scrollHeight;
            const nextY = startY + (targetY -startY) * eased;
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
          historyIndex = history.length -1;
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
        if (historyIndex < history.length -1) {
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
        const cancelQueuedBtn = e.target.closest('.cancel-queued-btn');
        if (cancelQueuedBtn) {
            const runId = cancelQueuedBtn.dataset.runId;
            if (runId) {
                vscode.postMessage({ type: 'cancelTask', runId });
                cancelQueuedBtn.disabled = true;
                cancelQueuedBtn.style.opacity = '0.5';
            }
            return;
        }

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

            // If search is active, refresh it for the new pane
            if (typeof searchControllers !== 'undefined') {
                const controller = searchControllers.get(runId);
                if (controller && controller.input.value) {
                    controller.performSearch();
                }
            }
        }

        // Search Handlers
        const searchToggle = e.target.closest('.search-toggle');
        if (searchToggle) {
            const runId = searchToggle.dataset.runId;
            const searchBar = document.getElementById('run-search-' + runId);
            if (searchBar) {
                const isHidden = searchBar.classList.toggle('hidden');
                if (!isHidden) {
                    const controller = getSearchController(runId);
                    controller.input.focus();
                } else {
                    const controller = searchControllers.get(runId);
                    if (controller) controller.close();
                }
            }
        }

        const btnNext = e.target.closest('.search-next');
        if (btnNext) {
            const controller = getSearchController(btnNext.dataset.runId);
            controller.next();
        }

        const btnPrev = e.target.closest('.search-prev');
        if (btnPrev) {
            const controller = getSearchController(btnPrev.dataset.runId);
            controller.prev();
        }

        const btnClose = e.target.closest('.search-close');
        if (btnClose) {
            const controller = getSearchController(btnClose.dataset.runId);
            controller.close();
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
        const reason = window._lastMsgType || null;
        console.log('[Busy] value=' + value + ' reason=' + (reason || 'unknown'));
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
        div.innerHTML = '<div class="user-bubble">' + window.stataUI.escapeHtml(code) + '</div>';
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
            +        '<span id="run-status-title-' + runId + '">Stata Output (waiting in queue…)</span>'
            +        '<button class="btn btn-ghost btn-xs cancel-queued-btn" id="run-cancel-' + runId + '" data-run-id="' + runId + '" title="Cancel this task"><i class="codicon codicon-close"></i></button>'
            +      '</div>'
            +      '<div class="flex items-center gap-sm">'
            +        '<span id="run-rc-' + runId + '"></span>'
            +        '<span id="run-duration-' + runId + '"></span>'
            +        '<span id="run-log-link-' + runId + '"></span>'
            +        '<button class="btn btn-ghost btn-icon search-toggle" data-run-id="' + runId + '" title="Search in this card"><i class="codicon codicon-search"></i></button>'
            +      '</div>'
            +    '</div>'
            +    '<div class="output-progress" id="run-progress-wrap-' + runId + '" style="display:none;">'
            +      '<div class="progress-row">'
            +        '<span class="progress-text" id="run-progress-text-' + runId + '"></span>'
            +        '<span class="progress-meta" id="run-progress-meta-' + runId + '"></span>'
            +      '</div>'
            +      '<div class="progress-bar"><div class="progress-fill" id="run-progress-fill-' + runId + '" style="width:0%;"></div></div>'
            +    '</div>'
            +    '<div class="output-search-bar hidden" id="run-search-' + runId + '">'
            +      '<div class="search-input-wrapper">'
            +        '<i class="codicon codicon-search" style="font-size: 12px; color: var(--text-tertiary);"></i>'
            +        '<input type="text" placeholder="Find..." id="run-search-input-' + runId + '" data-run-id="' + runId + '">'
            +        '<span class="search-counter" id="run-search-counter-' + runId + '">0/0</span>'
            +      '</div>'
            +      '<div class="search-actions">'
            +        '<button class="btn btn-ghost btn-icon search-prev" data-run-id="' + runId + '" title="Previous Match (Shift+Enter)"><i class="codicon codicon-arrow-up"></i></button>'
            +        '<button class="btn btn-ghost btn-icon search-next" data-run-id="' + runId + '" title="Next Match (Enter)"><i class="codicon codicon-arrow-down"></i></button>'
            +        '<button class="btn btn-ghost btn-icon search-close" data-run-id="' + runId + '" title="Close Search (Esc)"><i class="codicon codicon-close"></i></button>'
            +      '</div>'
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
            logLinkEl: document.getElementById('run-log-link-' + runId),
            logEl: document.getElementById('run-log-' + runId),
            tabsContainer: document.getElementById('run-tabs-' + runId),
            artifacts: []
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
            outputContent += \`<div class="output-content error">\${window.stataUI.smclToHtml(entry.stderr)}</div>\`;
        }
        if (entry.stdout) {
            outputContent += '<div class="output-content">' + window.stataUI.smclToHtml(entry.stdout) + '</div>';
        }
        
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
            +         (entry.logPath ? ('<span class="text-secondary" style="cursor:pointer;" title="' + window.stataUI.escapeHtml(entry.logPath) + '" data-action="open-artifact" data-path="' + window.stataUI.escapeHtml(entry.logPath) + '"><i class="codicon codicon-file-code"></i> Log</span>') : '')
            +         '<button class="btn btn-ghost btn-icon search-toggle" data-run-id="' + entry.timestamp + '" title="Search in this card"><i class="codicon codicon-search"></i></button>'
            +       '</div>'
            +     '</div>'
            +     '<div class="output-search-bar hidden" id="run-search-' + entry.timestamp + '">'
            +       '<div class="search-input-wrapper">'
            +         '<i class="codicon codicon-search" style="font-size: 12px; color: var(--text-tertiary);"></i>'
            +         '<input type="text" placeholder="Find..." id="run-search-input-' + entry.timestamp + '" data-run-id="' + entry.timestamp + '">'
            +         '<span class="search-counter" id="run-search-counter-' + entry.timestamp + '">0/0</span>'
            +       '</div>'
            +       '<div class="search-actions">'
            +         '<button class="btn btn-ghost btn-icon search-prev" data-run-id="' + entry.timestamp + '" title="Previous Match (Shift+Enter)"><i class="codicon codicon-arrow-up"></i></button>'
            +         '<button class="btn btn-ghost btn-icon search-next" data-run-id="' + entry.timestamp + '" title="Next Match (Enter)"><i class="codicon codicon-arrow-down"></i></button>'
            +         '<button class="btn btn-ghost btn-icon search-close" data-run-id="' + entry.timestamp + '" title="Close Search (Esc)"><i class="codicon codicon-close"></i></button>'
            +       '</div>'
            +     '</div>'
            +     '<div class="output-tabs" ' + tabsStyle + '>'
            +       '<button class="tab-btn active" data-run-id="' + entry.timestamp + '" data-tab="result">Result</button>'
            +       '<button class="tab-btn" data-run-id="' + entry.timestamp + '" data-tab="log">Log</button>'
            +     '</div>'
            +     '<div class="output-pane active" data-tab="result">'
            +       (entry.stderr ? ('<div class="output-content error">' + window.stataUI.smclToHtml(entry.stderr) + '</div>') : '')
            +       (entry.stdout ? ('<div class="output-content">' + window.stataUI.smclToHtml(entry.stdout) + '</div>') : '')
            +     '</div>'
            +     '<div class="output-pane" data-tab="log">'
            +       '<div class="output-content log-container" id="run-log-' + entry.timestamp + '" data-log-path="' + (entry.logPath || '') + '"></div>'
            +     '</div>'
            +   '</div>'
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
        const densityClass = artifacts.length >= 12
            ? 'artifacts-compact'
            : (artifacts.length >= 8 ? 'artifacts-dense' : '');

        const tiles = artifacts.map((a, idx) => {
          const label = window.stataUI.escapeHtml(a.label || 'graph');
          const preview = a.previewPath || a.path || '';
          const canPreview = !!preview && (String(a.path || preview).toLowerCase().indexOf('.svg') !== -1);
          if (canPreview) {
              console.log('[Artifacts] previewPath', preview, 'path', a.path || '');
          }
          const closeKey = window.stataUI.escapeHtml(String(a._key || ''));
          
          const error = a.error ? String(a.error) : '';
          const errorHtml = error
              ? '<div class="artifact-tile-error">' + window.stataUI.escapeHtml(error) + '</div>'
              : '';
          const thumbHtml = canPreview
              ? '<img src="' + window.stataUI.escapeHtml(preview) + '" class="artifact-thumb-img" alt="' + label + '">' 
              : '<div class="artifact-thumb-fallback">File</div>';

            const tileAttrs = canPreview
                ? ('data-action="preview-graph" data-src="' + window.stataUI.escapeHtml(preview) + '"')
                : 'data-action="open-artifact"';

            return (
                '<div class="artifact-tile" ' + tileAttrs
                + ' data-path="' + window.stataUI.escapeHtml(a.path || '') + '"'
                + ' data-basedir="' + window.stataUI.escapeHtml(a.baseDir || '') + '"'
                + ' data-label="' + label + '"'
                + ' data-index="' + idx + '">' 
                +   '<div class="artifact-thumb">'
                +     '<button class="artifact-tile-close" type="button" data-action="remove-artifact" data-key="' + closeKey + '" title="Remove">×</button>'
                +     thumbHtml
                +   '</div>'
                +   '<div class="artifact-tile-label" title="' + label + '">' + label + '</div>'
                +   errorHtml
                + '</div>'
            );
        }).join('');

        return (
            '<section class="artifacts-card ' + densityClass + '" data-artifacts-id="' + artifactsId + '" data-collapsed="' + (isCollapsed ? 'true' : 'false') + '">' 
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

    function bindArtifactImageEvents(container, runId) {
        if (!container) return;
        const images = container.querySelectorAll('img.artifact-thumb-img');
        images.forEach((img) => {
            if (img.dataset.bound === 'true') return;
            img.dataset.bound = 'true';
            const src = img.getAttribute('src') || '';
            const label = img.getAttribute('alt') || '';
            const started = Date.now();
            img.addEventListener('load', () => {
                const elapsed = Date.now() - started;
                vscode.postMessage({
                    type: 'log',
                    level: 'info',
                    message: '[Artifacts] img load (' + runId + ') ' + label + ' ' + elapsed + 'ms ' + src
                });
            }, { once: true });
            img.addEventListener('error', () => {
                const elapsed = Date.now() - started;
                vscode.postMessage({
                    type: 'log',
                    level: 'error',
                    message: '[Artifacts] img error (' + runId + ') ' + label + ' ' + elapsed + 'ms ' + src
                });
            }, { once: true });
        });
    }

    const collapsedArtifacts = Object.create(null);

    function renderSessionArtifacts() {
        if (!sessionArtifactsEl) return;
        const artifactsHtml = renderArtifacts(sessionArtifacts, 'session');
        sessionArtifactsEl.innerHTML = artifactsHtml;
        bindArtifactImageEvents(sessionArtifactsEl, 'session');
        console.log('[Artifacts] session render count=' + sessionArtifacts.length);
    }

    function addSessionArtifact(artifact) {
        if (!artifact) return false;
        const key = String(artifact.path || '') + '|' + String(artifact.label || '');
        if (!key || sessionArtifactKeys.has(key)) return false;
        sessionArtifactKeys.add(key);
        sessionArtifacts.push({ ...artifact, _key: key });
        return true;
    }

    function removeSessionArtifact(key) {
        if (!key || !sessionArtifactKeys.has(key)) return false;
        sessionArtifactKeys.delete(key);
        const index = sessionArtifacts.findIndex(a => a._key === key);
        if (index >= 0) {
            sessionArtifacts.splice(index, 1);
        }
        renderSessionArtifacts();
        return true;
    }

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

    // Download button handler -requests PDF export and downloads it
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
      window._lastMsgType = msg?.type || null;
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
        scheduleHighlight();
        return;
      }
      if (msg.type === 'busy') {
          setBusy(msg.value);
          return;
      }

      if (msg.type === 'task_done' || msg.type === 'taskDone') {
        const runId = msg.runId;
        const run = runs[runId];
        if (runId) taskDoneRuns.add(runId);
        if (!run) return;

        // Clear local progress bars
        if (run.progressWrap) {
            run.progressWrap.style.display = 'none';
            if (run.progressText) run.progressText.textContent = '';
            if (run.progressMeta) run.progressMeta.textContent = '';
        }

        // Update RC and Status Indicator if present
        if (msg.rc !== null && msg.rc !== undefined) {
             const success = (msg.rc === 0);
             if (run.statusDot) {
                 run.statusDot.style.color = success ? 'var(--accent-success)' : 'var(--accent-error)';
             }
             if (run.rcEl) {
                 run.rcEl.textContent = 'RC ' + String(msg.rc);
             }
             updateStatusIndicator(success, msg.rc);
        }

        // Fill HTML immediately if provided
        if (msg.stdout && run.stdoutEl) {
            const finalStdout = window.stataUI.smclToHtml(String(msg.stdout || ''));
            const currentStdout = run.stdoutEl.innerHTML;
            // No-replacement optimization: if what we have looks like a match for what just came in, avoid flicker.
            if (currentStdout && finalStdout && Math.abs(currentStdout.length - finalStdout.length) < 20) {
                 // close enough to avoid flicker
            } else {
                 run.stdoutEl.innerHTML = finalStdout;
            }
            run._taskDoneApplied = true;
        }

        // Clear busy state immediately on task_done so graphs don't block UI.
        setBusy(false);

        // Ensure highlight happens
        if (!run._highlighted && !run.viewer) {
            run._highlighted = true;
            scheduleHighlight();
        }
        return;
      }

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
        runMetrics[runId] = { start: Date.now(), logChunks: 0, logChars: 0 };
        ensureRunGroup(runId, code);
        updateStatusIndicator(null, null); // Reset status when run starts
      }

      if (msg.type === 'runStatusUpdate') {
        const runId = msg.runId;
        const status = msg.status;
        const run = runs[runId];
        if (run && run.statusTitle) {
            if (status === 'running') {
                run.statusTitle.textContent = 'Stata Output (running…)';
            } else if (status === 'queued') {
                run.statusTitle.textContent = 'Stata Output (waiting in queue…)';
            }
        }
      }

      if (msg.type === 'runCancelled') {
        const runId = msg.runId;
        const run = runs[runId];
        if (!run) return;

        const cancelBtn = document.getElementById('run-cancel-' + runId);
        if (cancelBtn) cancelBtn.style.display = 'none';

        if (run.statusDot) run.statusDot.style.color = 'var(--accent-warning)';
        if (run.statusTitle) run.statusTitle.textContent = 'Stata Output (cancelled)';
        if (run.stderrEl) {
            run.stderrEl.style.display = 'block';
            run.stderrEl.innerHTML = String(msg.message || 'Run cancelled.');
        }
        if (run.stdoutEl) {
            run.stdoutEl.style.display = 'none';
        }
        if (run.progressWrap) {
            if (run.progressText) run.progressText.textContent = '';
            if (run.progressMeta) run.progressMeta.textContent = '';
        }
        // Update header status for cancelled
        updateStatusIndicator(false, null);
        if (autoScrollPinned) scrollToBottomSmooth();
        if (typeof searchControllers !== 'undefined') {
            const controller = searchControllers.get(runId);
            if (controller && controller.input.value) {
                controller.performSearch();
            }
        }
      }

      if (msg.type === 'runArtifact') {
        const runId = msg.runId;
        const run = runs[runId];
        if (!run || !msg.artifact) return;
        const artifact = msg.artifact;

        if (addSessionArtifact(artifact)) {
            renderSessionArtifacts();
        }
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
        if (!run) return;

        const chunk = String(msg.text ?? '');
        if (!chunk) return;

        // Cumulative buffer for live-streaming of SMCL. 
        // We re-render the whole buffer for the Result pane to handle tags joining across chunks.
        if (run.rawStdout === undefined) run.rawStdout = '';
        run.rawStdout += chunk;

        // Keep raw buffer bounded to avoid performance degradation on extremely long live output.
        // 25KB is plenty for a live 'tail', and the full log is always accurate in the Log tab/file.
        const MAX_RAW_BUF = 25_000;
        if (run.rawStdout.length > MAX_RAW_BUF) {
            run.rawStdout = safeSliceTail(run.rawStdout, MAX_RAW_BUF);
        }

        const shouldStick = autoScrollPinned;
        
        if (run.stdoutEl) {
            run.stdoutEl.innerHTML = window.stataUI.smclToHtml(run.rawStdout);
        }
        
        if (run.logEl) {
            run.logEl.innerHTML = window.stataUI.smclToHtml(run.rawStdout);
        }
        
        scheduleHighlight();
        if (shouldStick) scheduleScrollToBottom();
        return;
      }

      if (msg.type === 'runProgress') {
        const runId = msg.runId;
        const run = runs[runId];
        if (!run || run._taskDoneApplied) return;
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

      const applyRunFinished = (msg) => {
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
        
        const cancelBtn = document.getElementById('run-cancel-' + runId);
        if (cancelBtn) cancelBtn.style.display = 'none';

        if (run.rcEl) {
            run.rcEl.textContent = (msg.rc !== null && msg.rc !== undefined) ? ('RC ' + String(msg.rc)) : '';
        }
        if (run.durationEl) {
            run.durationEl.textContent = msg.durationMs ? window.stataUI.formatDuration(msg.durationMs) : '';
        }
        
        if (run.logLinkEl && msg.logPath) {
             run.logLinkEl.innerHTML = '<span class="text-secondary" style="cursor:pointer;" title="' + window.stataUI.escapeHtml(msg.logPath) + '" data-action="open-artifact" data-path="' + window.stataUI.escapeHtml(msg.logPath) + '"><i class="codicon codicon-file-code"></i> Log</span>';
        }

        // Populate Log tab or Main Output based on success/logPath availability
        const useBufferedLog = !!msg.logPath;
        const LOG_VIEWER_THRESHOLD = 50_000;
        
        if (success && useBufferedLog && run.stdoutEl) {
            // SUCCESS + LOG EXISTS:
            // Use LogViewer only if the file is large. Otherwise, use the backfilled string
            // for a zero-flicker experience.
            if (msg.logSize > LOG_VIEWER_THRESHOLD) {
              run.viewer = new LogViewer(run.stdoutEl, msg.logPath, msg.logSize, runId, { autoLoadAll: true });
            } else {
                const finalStdout = window.stataUI.smclToHtml(String(msg.stdout || ''));
                const currentStdout = run.stdoutEl ? run.stdoutEl.innerHTML : '';
                const skipReplace = run._taskDoneApplied === true || (currentStdout && Math.abs(currentStdout.length - finalStdout.length) < 20);
                
                if (!skipReplace && finalStdout) {
                    run.stdoutEl.innerHTML = finalStdout;
                }
            }
            run.stdoutEl.style.display = 'block';
        } else if (success) {
             // SUCCESS + NO LOG: 
             // Keep the streamed content (backfilled if needed)
             const finalStdout = window.stataUI.smclToHtml(String(msg.stdout || ''));
             if (run.stdoutEl && finalStdout) {
                 const current = run.stdoutEl.innerHTML || '';
                 const MAX_STDOUT_DISPLAY = 20_000;
                 const normalizedFinal = safeSliceTail(finalStdout, MAX_STDOUT_DISPLAY);
                 if (!current || (normalizedFinal.length > current.length)) {
                     run.stdoutEl.innerHTML = normalizedFinal;
                 }
                 run.stdoutEl.style.display = 'block';
             }
        } else {
            // FAILURE: Automatic hiding of stdout 
            if (run.stdoutEl) {
                run.stdoutEl.style.display = 'none';
            }
        }
        
        if (run.logEl) {
             if (useBufferedLog) {
                 if (!success) {
                    run.logEl.innerHTML = '';
                    run.viewer = new LogViewer(run.logEl, msg.logPath, msg.logSize, runId, { autoLoadAll: true });
                } else {
                     // On success, we prioritize the Result pane.
                     run.logEl.innerHTML = '<div class="text-muted">Log viewed in Result pane</div>';
                 }
             } else {
                 // Fallback to memory content
                 run.logEl.innerHTML = window.stataUI.smclToHtml(String(msg.fullStdout || ''));
             }
        }

        // Show tabs ONLY if there was an error or a non-zero RC
        if (run.tabsContainer) {
            const hasProblem = !success || hasError || (msg.rc !== null && msg.rc !== 0);
            run.tabsContainer.style.display = hasProblem ? 'flex' : 'none';
        }

        if (Array.isArray(msg.artifacts) && msg.artifacts.length) {
            let changed = false;
            for (const artifact of msg.artifacts) {
                if (addSessionArtifact(artifact)) {
                    changed = true;
                }
            }
            if (changed) {
                renderSessionArtifacts();
            }
        }

        const stderr = String(msg.stderr || '');
        if (stderr && run.stderrEl) {
            run.stderrEl.style.display = 'block';
            run.stderrEl.innerHTML = window.stataUI.smclToHtml(stderr);
        } else if (!success && run.stderrEl) {
            const fallback = msg.rc != null ? ('Run failed (RC ' + msg.rc + ')') : 'Run failed';
            run.stderrEl.style.display = 'block';
            run.stderrEl.innerHTML = fallback;
        }

        if (run.progressWrap) {
            run.progressWrap.style.display = 'none';
            if (run.progressText) run.progressText.textContent = '';
            if (run.progressMeta) run.progressMeta.textContent = '';
        }

        const incomingArtifacts = Array.isArray(msg.artifacts) ? msg.artifacts : [];
        const mergedArtifacts = (run.artifacts || []).slice();
        run._artifactKeys = run._artifactKeys || new Set();
        for (const artifact of mergedArtifacts) {
            const key = String(artifact?.path || '') + '|' + String(artifact?.label || '');
            run._artifactKeys.add(key);
        }
        for (const artifact of incomingArtifacts) {
            const key = String(artifact?.path || '') + '|' + String(artifact?.label || '');
            if (run._artifactKeys.has(key)) continue;
            run._artifactKeys.add(key);
            mergedArtifacts.push(artifact);
        }
        const artifactsHtml = renderArtifacts(mergedArtifacts, runId);
        if (run.artifactsEl) {
            run.artifactsEl.innerHTML = artifactsHtml;
            bindArtifactImageEvents(run.artifactsEl, runId);
        }
        run.artifacts = mergedArtifacts;
        
        // Update header status indicator
        updateStatusIndicator(success, msg.rc);
        setBusy(false);

        if (taskDoneRuns.has(runId) && !run._highlighted && !run.viewer) {
            run._highlighted = true;
            scheduleHighlight();
        }

        if (autoScrollPinned) scrollToBottomSmooth();
        if (typeof searchControllers !== 'undefined') {
            const controller = searchControllers.get(runId);
            if (controller && controller.input.value) {
                controller.performSearch();
            }
        }
      };

      if (msg.type === 'runFinished') {
        const runId = msg.runId;
        const run = runs[runId];
        if (!run) return;
        if (run._taskDoneApplied && !msg._deferred) {
            console.log('[RunFinished] deferring runId=' + runId);
            const deferredMsg = Object.assign({}, msg, { _deferred: true });
            requestAnimationFrame(() => applyRunFinished(deferredMsg));
            return;
        }
        applyRunFinished(msg);
      }

      if (msg.type === 'runFailed') {
        const runId = msg.runId;
        const run = runs[runId];
        if (!run) return;

        const cancelBtn = document.getElementById('run-cancel-' + runId);
        if (cancelBtn) cancelBtn.style.display = 'none';

        if (run.statusDot) run.statusDot.style.color = 'var(--accent-error)';
        if (run.statusTitle) run.statusTitle.textContent = 'Stata Output (failed)';
        if (run.stderrEl) {
            run.stderrEl.style.display = 'block';
            run.stderrEl.textContent = String(msg.message || 'Unknown error');
        }
        if (run.stdoutEl) {
            run.stdoutEl.style.display = 'none';
        }
        
        // Update header status for failed run
        updateStatusIndicator(false, null);
        setBusy(false);

        if (autoScrollPinned) scrollToBottomSmooth();
        if (typeof searchControllers !== 'undefined') {
            const controller = searchControllers.get(runId);
            if (controller && controller.input.value) {
                controller.performSearch();
            }
        }
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
        Sentry.captureException(err);
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
        const removeBtn = e.target.closest('[data-action="remove-artifact"]');
        if (removeBtn) {
            const key = removeBtn.getAttribute('data-key');
            removeSessionArtifact(key);
            return;
        }
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
        return (window.innerHeight + window.scrollY) >= document.body.offsetHeight -50;
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
      const start = pos -prefix.length;
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

    class SearchController {
        constructor(runId) {
            this.runId = runId;
            this.card = document.querySelector('.message-group[data-run-id="' + runId + '"]');
            this.input = document.getElementById('run-search-input-' + runId);
            this.counter = document.getElementById('run-search-counter-' + runId);
            
            this.activePane = null;
            this.markInstance = null;
            this.results = [];
            this.currentIndex = -1;
            
            this.init();
        }

        init() {
            this.input.addEventListener('input', () => this.performSearch());
            this.input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (e.shiftKey) this.prev();
                    else this.next();
                } else if (e.key === 'Escape') {
                    this.close();
                }
            });
        }

        getMarkContext() {
            // Find the currently active output-pane in this card
            const activePane = this.card.querySelector('.output-pane.active');
            if (!activePane) return null;
            // Get visible content within pane (either stderr or stdout)
            const content = Array.from(activePane.querySelectorAll('.output-content'))
                .find(el => el.style.display !== 'none');
            return content || activePane;
        }

        performSearch() {
            const query = this.input.value;
            const context = this.getMarkContext();
            
            if (!context) return;
            
            if (this.activePane !== context || !this.markInstance) {
                if (this.markInstance) this.markInstance.unmark();
                this.markInstance = new Mark(context);
                this.activePane = context;
            }

            this.markInstance.unmark({
                done: () => {
                    if (!query || query.length < 2) {
                        this.updateCounter(0, 0);
                        return;
                    }

                    this.markInstance.mark(query, {
                        acrossElements: true,
                        separateWordSearch: false,
                        accuracy: 'partially',
                        diacritics: true,
                        done: (count) => {
                            this.results = Array.from(this.activePane.querySelectorAll('mark'));
                            this.currentIndex = count > 0 ? 0 : -1;
                            this.updateCounter(this.currentIndex + 1, count);
                            if (count > 0) this.jumpTo(0);
                        }
                    });
                }
            });
        }

        updateCounter(current, total) {
            if (this.counter) {
                this.counter.textContent = total > 0 ? (current + '/' + total) : '0/0';
            }
        }

        jumpTo(index) {
            if (this.results.length === 0) return;
            
            // Remove active class from all
            this.results.forEach(m => m.classList.remove('active'));
            
            this.currentIndex = (index + this.results.length) % this.results.length;
            const target = this.results[this.currentIndex];
            target.classList.add('active');
            
            // Use a smoother scroll into view within the scrolling parent if possible
            target.scrollIntoView({ behavior: 'auto', block: 'nearest' });
            this.updateCounter(this.currentIndex + 1, this.results.length);
        }

        next() { this.jumpTo(this.currentIndex + 1); }
        prev() { this.jumpTo(this.currentIndex -1); }

        close() {
            const searchBar = document.getElementById('run-search-' + this.runId);
            if (searchBar) searchBar.classList.add('hidden');
            if (this.markInstance) this.markInstance.unmark();
            this.input.value = '';
            this.updateCounter(0, 0);
            this.currentIndex = -1;
            this.results = [];
            this.activePane = null;
        }
    }

    const searchControllers = new Map();

    function getSearchController(runId) {
        if (!searchControllers.has(runId)) {
            searchControllers.set(runId, new SearchController(runId));
        }
        return searchControllers.get(runId);
    }

    class LogViewer {
      constructor(container, logPath, logSize, runId, options = {}) {
            this.container = container;
            this.logPath = logPath;
            this.logSize = logSize || 0;
            this.runId = runId;
        this.offset = 0; 
        const defaultMax = Number.isFinite(options.maxBytes) ? options.maxBytes : 50000;
        this.maxBytes = (options.autoLoadAll === true && Number.isFinite(this.logSize) && this.logSize > 0)
          ? this.logSize
          : defaultMax;
        this.autoLoadAll = options.autoLoadAll === true;
            this.isFirstLoad = true;
            this.isLoading = false;
            
        // Calculate initial offset to show tail unless auto-loading full log
        if (this.autoLoadAll) {
          this.offset = 0;
        } else if (this.logSize > this.maxBytes) {
          this.offset = this.logSize -this.maxBytes;
        } else {
          this.offset = 0;
        }
            
            // Do NOT clear the container immediately with "Loading..." to avoid flash.
            // Keeping existing content (streamed output) until the first chunk arrives is smoother.
            // this.container.innerHTML = '<div class="log-loading">Loading log...</div>';
            
            // Force container to be scrollable
            this.container.classList.add('scrollable-log');
            this.container.addEventListener('scroll', this.onScroll.bind(this));
            
            console.log('[LogViewer] Initializing. Size:', this.logSize, 'Start Offset:', this.offset, 'AutoLoadAll:', this.autoLoadAll);
            this.fetchChunk(this.offset);
        }
        
        onScroll() {
            if (this.isLoading) return;
            // Native scrolling Up
            // Use a threshold (e.g. 50px) instead of strictly 0 to handle faster scrolls or sub-pixel differences
            if (this.container.scrollTop < 50 && this.offset > 0) {
                 // Prepend previous chunk
                 const newOffset = Math.max(0, this.offset -this.maxBytes);
                 console.log('[LogViewer] Scrolling up. Fetching from', newOffset);
                 this.fetchChunk(newOffset, true); // true = prepend
            }
        }
        
        fetchChunk(offset, isPrepend = false) {
            this.isLoading = true;
            this.pendingPrepend = isPrepend;
            vscode.postMessage({
                type: 'fetchLog',
                runId: this.runId,
                path: this.logPath,
                offset: offset,
                maxBytes: this.maxBytes
            });
        }
        
        appendData(data, nextOffset) {
             this.isLoading = false;
             
             // Remove loading indicator
             const loader = this.container.querySelector('.log-loading');
             if (loader) loader.remove();
             
             // When the first chunk arrives, we clear the container to replace the streamed/partial context.
             // We do this JUST before adding the new content to minimize the "blank" window.
             if (this.isFirstLoad) {
                 this.container.innerHTML = '';
                 this.isFirstLoad = false;
                 
                  // If we got no data on the first chunk of a non-empty log, something is wrong.
                  // We'll show a small warning so the user knows why it's blank.
                  if (!data && this.logSize > 0) {
                      console.error('[LogViewer] Received empty data for first chunk of non-empty log', {
                          path: this.logPath,
                          size: this.logSize,
                          offset: this.offset
                      });
                      const errorDiv = document.createElement('div');
                      errorDiv.className = 'log-error';
                      errorDiv.style.padding = '12px';
                      errorDiv.style.opacity = '0.7';
                      errorDiv.innerHTML = '<i class="codicon codicon-warning"></i> Log file contains ' + this.logSize + ' bytes but tail read returned no data. Check developer console for details.';
                      this.container.appendChild(errorDiv);
                      return;
                  }
             }
             
             if (!data && !this.pendingPrepend) return;

             const div = document.createElement('div');
             div.className = 'log-chunk';
             div.innerHTML = window.stataUI.smclToHtml(data || '');
             
             if (this.pendingPrepend) {
                 // Prepend
                 // Maintain scroll position?
                 const oldHeight = this.container.scrollHeight;
                 this.container.prepend(div);
                 const newHeight = this.container.scrollHeight;
                 this.container.scrollTop = newHeight -oldHeight;
                 
                 // Update local offset tracker to the NEW lowest point
                 this.offset = Math.max(0, this.offset -this.maxBytes);
                 this.pendingPrepend = false;
             } else {
                 // Append (Initial load or scroll down if implemented)
                 this.container.appendChild(div);
                 scheduleHighlight();
                 // If initial tail load, autoscroll to bottom?
                 // Usually yes for terminal output.
                 // Only if we haven't scrolled manually? 
                 // For first load from tail, yes.
                 if (this.offset + (data ? data.length : 0) >= this.logSize || this.offset === 0) {
                     // Wait, checking offset against size is tricky with bytes vs chars.
                     // Simple heuristic: If it's the very first render of the tail, scroll to bottom.
                      this.container.scrollTop = this.container.scrollHeight;
                 }

                 // If configured, keep loading forward until the end of the log.
                 if (this.autoLoadAll && typeof nextOffset === 'number' && nextOffset > this.offset && nextOffset < this.logSize) {
                   this.offset = nextOffset;
                   this.fetchChunk(nextOffset);
                 }
             }
        }
    }
    
    // Register global handler for log chunks
    window.addEventListener('message', ev => {
        if (ev.data.type === 'logChunk') {
            const { runId, data, nextOffset } = ev.data;
            const run = runs[runId];
            if (run && run.viewer) {
                run.viewer.appendData(data, nextOffset);
            }
        }
    });
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

  // Return the complete entry object
  return {
    code,
    success,
    hasError: parsed.hasError,
    rc: finalRC,
    durationMs: result?.durationMs ?? null,
    stdout,
    fullStdout: result?.stdout || result?.contentText || '',
    stderr,
    artifacts: normalizeArtifacts(result),
    timestamp: Date.now()
  };
}

/**
 * Normalizes artifact objects for display in the terminal panel.
 * @param {object} result
 * @returns {Array<object>}
 */
function normalizeArtifacts(result) {
  const preferred = Array.isArray(result?.graphArtifacts)
    ? result.graphArtifacts
    : (result?.artifacts || []);
  if (!Array.isArray(preferred)) return [];
  const webview = TerminalPanel.currentPanel?.webview || null;
  const normalized = preferred.map((a) => {
    if (!a) return null;
    const label = a.label || path.basename(a.path || '') || 'artifact';
    const baseDir = a.baseDir || result?.cwd || (result?.filePath ? path.dirname(result.filePath) : null);
    const resolved = a.path ? resolveArtifactUri(a.path, baseDir) : null;
    const previewPath = (webview && resolved && resolved.scheme === 'file' && resolved.fsPath.toLowerCase().endsWith('.svg'))
      ? webview.asWebviewUri(resolved).toString()
      : null;
    return {
      label,
      path: a.path || '',
      previewPath,
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

function stripSmclTags(text) {
  return String(text ?? '')
    .replace(/\{hline\}/g, '--------------------------------------------------')
    .replace(/\{[^}]+\}/g, '');
}

function formatStreamChunk(text) {
  return String(text ?? '').replace(/\r\n/g, '\n');
}


function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}