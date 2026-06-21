'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { Command } from './common';
import { outputPanel } from '../umlmark/common';

/** Partial structure of a UMLGen YAML config — only routing-relevant fields */
interface UmlGenConfig {
    diagram?: { type?: string };
    runtime?: { language?: string };
    output?: { path?: string };
}

/**
 * CLI command routing table.
 *
 * Outer key: diagram.type  (class | sequence)
 * Inner key: runtime.language  (java | python | ...)
 *
 * TypeScript/JavaScript are intentionally absent — they are reserved for
 * future tsc-gen / tss-gen support and receive a dedicated error message.
 */
const COMMAND_MAP: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    sequence: {
        java:   'umls-gen',
        python: 'pys-gen',
        // typescript: 'tss-gen',  // reserved — not yet supported by umlgen
        // javascript: 'tss-gen',  // reserved — not yet supported by umlgen
    },
    class: {
        java:   'umlc-gen',
        python: 'pyc-gen',
        // typescript: 'tsc-gen',  // reserved — not yet supported by umlgen
        // javascript: 'tsc-gen',  // reserved — not yet supported by umlgen
    },
};

/** Languages whose CLI tools are planned but not yet available in umlgen */
const RESERVED_LANGUAGES = new Set(['typescript', 'javascript']);

/** Duration (ms) to wait for the output file before giving up */
const WATCHER_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

/**
 * Read and parse a UMLGen YAML config file.
 * Throws on read or YAML parse error.
 */
function parseUmlGenConfig(filePath: string): UmlGenConfig {
    const content = fs.readFileSync(filePath, 'utf8');
    return (yaml.load(content) as UmlGenConfig) ?? {};
}

/**
 * Resolve the CLI binary name from parsed config fields.
 * Returns undefined when the combination is not in the routing table.
 */
function resolveCliCommand(config: UmlGenConfig): string | undefined {
    const type = config.diagram?.type?.toLowerCase().trim() ?? '';
    const lang = config.runtime?.language?.toLowerCase().trim() ?? '';
    return COMMAND_MAP[type]?.[lang];
}

/**
 * Convert an absolute file path to a workspace-relative path string
 * using forward slashes, safe for cross-platform CLI usage.
 *
 * Windows backslashes are normalised to '/' so the generated command
 * works identically on Windows, macOS, and Linux.
 */
function toRelativePosixPath(fileUri: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder): string {
    const rel = path.relative(workspaceFolder.uri.fsPath, fileUri.fsPath);
    return rel.split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// File watcher factory
// ---------------------------------------------------------------------------

/**
 * Register a one-shot file system watcher that:
 *   - opens the output file when it is created or changed (success path), and
 *   - emits a warning notification when 30 s elapse without a file event (timeout path).
 *
 * Returns a Disposable that cancels both the watcher and the timeout when called early.
 */
function registerOutputWatcher(
    workspaceFolder: vscode.WorkspaceFolder,
    outputPath: string
): vscode.Disposable {
    const outputUri = vscode.Uri.joinPath(workspaceFolder.uri, outputPath);

    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceFolder, outputPath),
        false, // watch onDidCreate
        false, // watch onDidChange
        true   // ignore onDidDelete
    );

    // Use a shared state object to make the timeout/watcher relationship explicit
    // and avoid temporal dead-zone issues with let-declared timeouts in closures.
    const state = { disposed: false, timeoutHandle: undefined as ReturnType<typeof setTimeout> | undefined };

    const cleanup = (): void => {
        if (state.disposed) { return; }
        state.disposed = true;
        clearTimeout(state.timeoutHandle);
        watcher.dispose();
    };

    const onFileReady = (): void => {
        if (state.disposed) { return; }
        cleanup();
        outputPanel.appendLine(`[generateUmlDiagram] output file ready: ${outputPath}`);
        vscode.window.showInformationMessage(`UML Diagram (${outputPath}) generated successfully`);
        vscode.commands.executeCommand('vscode.open', outputUri);
    };

    watcher.onDidCreate(onFileReady);
    watcher.onDidChange(onFileReady);

    state.timeoutHandle = setTimeout(() => {
        if (state.disposed) { return; }
        cleanup();
        outputPanel.appendLine(`[generateUmlDiagram] watcher timeout (30s), output not detected: ${outputPath}`);
        vscode.window.showWarningMessage(
            `UMLMark: UMLGen command timed out — output file "${outputPath}" was not detected ` +
            `within 30 s. Check the terminal for errors.`
        );
    }, WATCHER_TIMEOUT_MS);

    return { dispose: cleanup };
}

// ---------------------------------------------------------------------------
// Command implementation
// ---------------------------------------------------------------------------

/**
 * VS Code command: UMLMark: Generate UML Diagram
 *
 * Reads the active or right-clicked YAML config file, routes to the correct
 * UMLGen CLI tool, sends the command to the active terminal, and automatically
 * opens the generated .puml file when it appears on disk.
 */
export class CommandRunUmlGen extends Command {
    constructor() {
        super('umlmark.generateUmlDiagram');
    }

    async execute(uri?: vscode.Uri): Promise<void> {
        // 1. Resolve target YAML file URI (context menu arg or active editor)
        const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!fileUri) {
            vscode.window.showErrorMessage('UMLMark: No YAML file selected or active.');
            return;
        }

        // 2. File must belong to a workspace folder (required for relative-path resolution)
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('UMLMark: File must be inside a workspace folder.');
            return;
        }

        // 3. Parse the YAML config
        let config: UmlGenConfig;
        try {
            config = parseUmlGenConfig(fileUri.fsPath);
        } catch (err) {
            const msg = `Failed to parse YAML — ${String(err)}`;
            vscode.window.showErrorMessage(`UMLMark: ${msg}`);
            outputPanel.appendLine(`[generateUmlDiagram] YAML parse error: ${String(err)}`);
            return;
        }

        // 4. Route to the correct CLI binary
        const cliCmd = resolveCliCommand(config);
        if (!cliCmd) {
            const type = config.diagram?.type ?? '(undefined)';
            const lang = config.runtime?.language ?? '(undefined)';
            const langLower = lang.toLowerCase();
            const detail = RESERVED_LANGUAGES.has(langLower)
                ? `runtime.language "${lang}" is reserved for future support (tsc-gen / tss-gen). Not yet available.`
                : `非 UMLGen YAML 文件，无法确定命令 (diagram.type="${type}", runtime.language="${lang}")`;
            vscode.window.showErrorMessage(`UMLMark: ${detail}`);
            outputPanel.appendLine(`[generateUmlDiagram] unknown mapping: type="${type}" lang="${lang}"`);
            return;
        }

        // 5. Build the terminal command.
        //    Path is workspace-relative with forward slashes; quoted to handle spaces.
        const relConfigPath = toRelativePosixPath(fileUri, workspaceFolder);
        const terminalCmd = `${cliCmd} --config "${relConfigPath}"`;
        outputPanel.appendLine(`[generateUmlDiagram] dispatch: ${terminalCmd}`);

        // 6. Register the output file watcher before sending to terminal
        //    to prevent a race condition where a fast command completes before
        //    the watcher is in place.
        const outputPath = config.output?.path;
        let watcherDisposable: vscode.Disposable | undefined;
        if (outputPath) {
            watcherDisposable = registerOutputWatcher(workspaceFolder, outputPath);
        }

        // 7. Require an active terminal (preserves the user's venv activation)
        const terminal = vscode.window.activeTerminal;
        if (!terminal) {
            watcherDisposable?.dispose();
            vscode.window.showErrorMessage(
                'UMLMark: No active terminal found. ' +
                'Please open a terminal with the UMLGen virtual environment activated, then retry.'
            );
            return;
        }

        // 8. Send the command to the terminal and notify the user
        terminal.show(); // reveal terminal so the user can see output
        terminal.sendText(terminalCmd);
        vscode.window.setStatusBarMessage('UMLMark: UMLGen command dispatched', 5000);
        outputPanel.appendLine(`[generateUmlDiagram] command sent to terminal: ${terminalCmd}`);
    }
}
