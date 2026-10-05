'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { Command } from './common';
import * as os from 'os';
import { execFile } from 'child_process';
import { outputPanel } from '../umlmark/common';
import { isErr } from '../umlgen/configSpec';
import {
    buildTerminalCommand, EnvCheck, planGeneration, Platform, projectEnvCandidates, ShellKind, venvExecutable,
} from '../umlgen/umlgenEnv';

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
// UMLGen environment (C1 / Q23–Q27) — effects only; planning is in ../umlgen/umlgenEnv
// ---------------------------------------------------------------------------

const TERMINAL_NAME = 'UMLGen';
const PLATFORM: Platform = process.platform === 'win32' ? 'win32' : 'posix';
/** The UMLGen terminal is created with a known shell so quoting/chaining is deterministic */
const SHELL: ShellKind = PLATFORM === 'win32' ? 'powershell' : 'posix';
const OPEN_SETTINGS = 'Open Settings';

/** Show an environment problem with a shortcut to the umlmark.umlgen settings */
function warnEnvironment(message: string): void {
    vscode.window.showWarningMessage(`UMLMark: ${message}`, OPEN_SETTINGS).then(choice => {
        if (choice === OPEN_SETTINGS) {
            vscode.commands.executeCommand('workbench.action.openSettings', 'umlmark.umlgen');
        }
    });
}

async function pathExists(p: string): Promise<boolean> {
    try {
        await fs.promises.access(p);
        return true;
    } catch {
        return false;
    }
}

/** First check whose path is missing; every check is logged (Q27) */
async function firstFailedCheck(checks: readonly EnvCheck[]): Promise<EnvCheck | undefined> {
    for (const check of checks) {
        const ok = await pathExists(check.path);
        outputPanel.appendLine(`[generateUmlDiagram] env check id=${check.id} ok=${ok} path=${check.path}`);
        if (!ok) { return check; }
    }
    return undefined;
}

/** First project venv (.venv, venv) that contains a Python executable (Q25) */
async function firstProjectEnv(workspaceRoot: string): Promise<string | undefined> {
    for (const candidate of projectEnvCandidates(workspaceRoot)) {
        if (await pathExists(venvExecutable(candidate, 'python', PLATFORM))) { return candidate; }
    }
    return undefined;
}

/** `uv` when it is on PATH, otherwise pip through the project Python (Q25) */
function detectInstaller(): Promise<'uv' | 'pip'> {
    return new Promise(resolve => {
        execFile('uv', ['--version'], { timeout: 5000 }, err => resolve(err ? 'pip' : 'uv'));
    });
}

/** Reuse the live "UMLGen" terminal, or create it with a known shell (Q26) */
function umlGenTerminal(workspaceRoot: string): vscode.Terminal {
    const existing = vscode.window.terminals.find(t => t.name === TERMINAL_NAME && t.exitStatus === undefined);
    if (existing) {
        outputPanel.appendLine(`[generateUmlDiagram] terminal reused`);
        return existing;
    }
    const shellPath = PLATFORM === 'win32'
        ? 'powershell.exe'
        : (fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
    outputPanel.appendLine(`[generateUmlDiagram] terminal created shell=${shellPath}`);
    return vscode.window.createTerminal({ name: TERMINAL_NAME, cwd: workspaceRoot, shellPath });
}

// ---------------------------------------------------------------------------
// Command implementation
// ---------------------------------------------------------------------------

/**
 * VS Code command: UMLMark: Generate UML Diagram
 *
 * Reads the active or right-clicked YAML config file, routes to the correct
 * UMLGen CLI tool, validates the UMLGen environment (C1), sends the command to the
 * dedicated "UMLGen" terminal, and automatically
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

        // 5. Plan the UMLGen environment (C1): settings → venv / project env → CLI path
        const language = config.runtime?.language?.toLowerCase().trim() ?? '';
        const workspaceRoot = workspaceFolder.uri.fsPath;
        const projectEnv = language === 'python' ? await firstProjectEnv(workspaceRoot) : undefined;
        const settings = vscode.workspace.getConfiguration('umlmark.umlgen', fileUri);
        const planned = planGeneration({
            settings: { sourcePath: settings.get<string>('sourcePath'), venvPath: settings.get<string>('venvPath') },
            home: os.homedir(),
            platform: PLATFORM,
            language,
            cliName: cliCmd,
            projectEnv,
        });
        if (isErr(planned)) {
            outputPanel.appendLine(`[generateUmlDiagram] env ${planned.error.code}`);
            warnEnvironment(planned.error.message);
            return;
        }
        const plan = planned.value;
        outputPanel.appendLine(
            `[generateUmlDiagram] env source=${plan.sourcePath} venv=${plan.venvPath} ` +
            `python-env=${plan.pythonEnv} cli=${plan.cliPath}`
        );

        // 6. Verify every required path before touching a terminal (Q27)
        const failed = await firstFailedCheck(plan.checks);
        if (failed) {
            warnEnvironment(`UMLGen environment check failed — ${failed.label} not found: ${failed.path}`);
            return;
        }

        // 7. Build the command: cd workspace → (Python project env: install UMLGen) → generate
        const installer = plan.installInto ? await detectInstaller() : 'uv';
        const relConfigPath = toRelativePosixPath(fileUri, workspaceFolder);
        const terminalCmd = buildTerminalCommand({ shell: SHELL, workspaceRoot, plan, configRelPath: relConfigPath, installer });
        outputPanel.appendLine(`[generateUmlDiagram] dispatch installer=${plan.installInto ? installer : '-'}: ${terminalCmd}`);

        // 8. Register the output file watcher before sending to terminal
        //    to prevent a race condition where a fast command completes before
        //    the watcher is in place.
        const outputPath = config.output?.path;
        if (outputPath) {
            registerOutputWatcher(workspaceFolder, outputPath);
        }

        // 9. Send to the dedicated UMLGen terminal (Q26) and notify the user
        const terminal = umlGenTerminal(workspaceRoot);
        terminal.show(); // reveal terminal so the user can see output
        terminal.sendText(terminalCmd);
        vscode.window.setStatusBarMessage('UMLMark: UMLGen command dispatched', 5000);
        outputPanel.appendLine(`[generateUmlDiagram] command sent to terminal "${TERMINAL_NAME}"`);
    }
}
