'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Command } from './common';
import { outputPanel } from '../umlmark/common';
import { contextManager } from '../umlmark/context';
import {
    buildConfigSpec, ConfigSpec, ConfigTarget, DiagramKind, EntryRule, isErr, isSameSource, languageOf,
    SelectionEntry, SkippedEntry, SUPPORT_FILES, targetFor, toPosixRelative, UML_DIR,
} from '../umlgen/configSpec';
import { patchTemplate } from '../umlgen/configPatch';
import { buildHeaderLines, readConfigSource } from '../umlgen/configHeader';
import { entryRuleFor, FrameKind, SymbolFrame } from '../umlgen/entryRule';

/** Log prefix shared by every line this feature writes to Output › UMLMark */
const LOG = '[createUmlGenConfig]';

/** Command id of the existing "Generate UML Diagram" command (Q13: Generate Now action) */
const GENERATE_COMMAND = 'umlmark.generateUmlDiagram';
const GENERATE_NOW = 'Generate Now';
const EXTENSION_ID = 'petercai.umlmark';

const COMMAND_TITLES: Readonly<Record<DiagramKind, string>> = {
    class: 'Create UMLGen Class Config',
    sequence: 'Create UMLGen Sequence Config',
};

/** VS Code symbol kinds mapped to the frames the entry rule understands; others are only descended into */
const FRAME_BY_SYMBOL_KIND: ReadonlyMap<vscode.SymbolKind, FrameKind> = new Map([
    [vscode.SymbolKind.Class, 'class'],
    [vscode.SymbolKind.Interface, 'class'],
    [vscode.SymbolKind.Struct, 'class'],
    [vscode.SymbolKind.Enum, 'class'],
    [vscode.SymbolKind.Method, 'method'],
    [vscode.SymbolKind.Constructor, 'method'],
    [vscode.SymbolKind.Function, 'function'],
] as Array<[vscode.SymbolKind, FrameKind]>);

type FileEffect = 'copied' | 'exists-skip' | 'created';

/** Where the command was invoked from; only the editor body is cursor-aware (Q30) */
type InvocationSource = 'explorer' | 'editor' | 'editor-tab' | 'palette';

interface Invocation {
    readonly uris: vscode.Uri[];
    readonly source: InvocationSource;
}

// ---------------------------------------------------------------------------
// Effectful helpers (I/O isolated here; planning lives in ../umlgen/*)
// ---------------------------------------------------------------------------

/**
 * Single resolution point for the bundled templates.
 * Q15 (a template-dir override setting) was closed as won't-do (Q22-A); this stays the only seam.
 */
function resolveTemplateDir(): string {
    // Resolve via the extension API, not __dirname: the bundled dist/extension.js has a different depth than the tsc output.
    const extensionPath = contextManager.context?.extensionPath
        ?? vscode.extensions.getExtension(EXTENSION_ID)?.extensionPath;
    if (!extensionPath) {
        throw new Error(`Cannot resolve install path of extension ${EXTENSION_ID}`);
    }
    return path.join(extensionPath, 'umlgen');
}

function extensionVersion(): string {
    return vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON?.version ?? 'unknown';
}

/**
 * Collect the URIs the command was invoked with and classify the invocation.
 *
 * - explorer/context passes (clickedUri, selectedUris[])
 * - editor/title/context passes (uri, { groupId, … })
 * - editor/context passes (uri)
 * - Command Palette passes nothing → fall back to the active editor
 */
function collectInvocation(clicked?: vscode.Uri, selected?: unknown): Invocation {
    if (Array.isArray(selected) && selected.length > 0) {
        return { uris: selected.filter((u): u is vscode.Uri => u instanceof vscode.Uri), source: 'explorer' };
    }
    if (clicked instanceof vscode.Uri) {
        const isTab = typeof selected === 'object' && selected !== null && 'groupId' in selected;
        return { uris: [clicked], source: isTab ? 'editor-tab' : 'editor' };
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    return { uris: active ? [active] : [], source: 'palette' };
}

/** Classify one URI for the pure planner (stat + owning workspace folder) */
async function toSelectionEntry(uri: vscode.Uri): Promise<SelectionEntry> {
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    if (uri.scheme !== 'file') {
        return { fsPath: uri.fsPath || uri.toString(), entryType: 'missing', workspaceRoot };
    }
    try {
        const stat = await fs.promises.stat(uri.fsPath);
        return { fsPath: uri.fsPath, entryType: stat.isDirectory() ? 'directory' : 'file', workspaceRoot };
    } catch {
        return { fsPath: uri.fsPath, entryType: 'missing', workspaceRoot };
    }
}

/** Symbols enclosing `position`, outermost first (DocumentSymbol trees only) */
function enclosingFrames(symbols: readonly vscode.DocumentSymbol[], position: vscode.Position): SymbolFrame[] {
    const hit = symbols.find(s => s.range.contains(position));
    if (!hit) { return []; }
    const kind = FRAME_BY_SYMBOL_KIND.get(hit.kind);
    const own = kind ? [{ kind, name: hit.name }] : [];
    return [...own, ...enclosingFrames(hit.children ?? [], position)];
}

/**
 * Cursor-aware entry (Q18-B / Q30): sequence command, invoked on the active editor body
 * (editor context menu or Command Palette), single file. Everything else uses the whole file.
 */
async function resolveEntry(kind: DiagramKind, invocation: Invocation): Promise<EntryRule | undefined> {
    const editor = vscode.window.activeTextEditor;
    const eligible = kind === 'sequence'
        && (invocation.source === 'editor' || invocation.source === 'palette')
        && invocation.uris.length === 1
        && editor !== undefined
        && editor.document.uri.toString() === invocation.uris[0].toString();
    if (!eligible || !editor) { return undefined; }

    const fileUri = editor.document.uri;
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(fileUri)?.uri.fsPath;
    const language = languageOf(fileUri.fsPath);
    if (!workspaceRoot || !language) { return undefined; }

    const symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
        'vscode.executeDocumentSymbolProvider', fileUri,
    );
    // Flat SymbolInformation results carry no nesting, so they cannot locate the enclosing class
    const tree = (symbols ?? []).filter((s): s is vscode.DocumentSymbol => 'children' in s);
    if (tree.length === 0) {
        outputPanel.appendLine(`${LOG} entry symbols=unavailable → whole file`);
        return undefined;
    }

    const frames = enclosingFrames(tree, editor.selection.active);
    const entry = entryRuleFor(language, toPosixRelative(workspaceRoot, fileUri.fsPath), frames);
    outputPanel.appendLine(
        `${LOG} entry symbols=${tree.length} frames=${frames.map(f => `${f.kind}:${f.name}`).join('>') || '-'} ` +
        `rule=${entry?.rule ?? 'whole-file'}`
    );
    return entry;
}

async function fileExists(fsPath: string): Promise<boolean> {
    try {
        await fs.promises.access(fsPath);
        return true;
    } catch {
        return false;
    }
}

/** Copy a bundled file only when the target is absent — user edits are never overwritten */
async function copyIfMissing(source: string, target: string): Promise<FileEffect> {
    if (await fileExists(target)) { return 'exists-skip'; }
    await fs.promises.copyFile(source, target);
    return 'copied';
}

const absolutePath = (spec: ConfigSpec, relPosix: string): string =>
    path.join(spec.workspaceRoot, ...relPosix.split('/'));

/**
 * Pick the config target (Q7 / Q29): the first candidate that is free (create) or already
 * owned by the same source (open). A candidate owned by another source is skipped.
 */
async function chooseTarget(spec: ConfigSpec): Promise<{ target: ConfigTarget; effect: FileEffect } | undefined> {
    for (const stem of spec.nameCandidates) {
        const target = targetFor(spec, stem);
        const configPath = absolutePath(spec, target.configRelPath);
        if (!(await fileExists(configPath))) { return { target, effect: 'created' }; }

        const existingSource = readConfigSource(await fs.promises.readFile(configPath, 'utf8'));
        if (isSameSource(existingSource, spec.sources[0])) { return { target, effect: 'exists-skip' }; }
        outputPanel.appendLine(`${LOG} collision config=${target.configRelPath} existingSource=${existingSource} anchor=${spec.sources[0]}`);
    }
    return undefined;
}

function logSkipped(skipped: readonly SkippedEntry[]): void {
    skipped.forEach(s => outputPanel.appendLine(`${LOG} skipped reason=${s.reason} path=${s.fsPath}`));
}

/** One warning toast summarising skipped inputs; per-file detail stays in the output channel */
function warnSkipped(skipped: readonly SkippedEntry[]): void {
    if (skipped.length === 0) { return; }
    const reasons = Array.from(new Set(skipped.map(s => s.reason))).join(', ');
    vscode.window.showWarningMessage(
        `UMLMark: Skipped ${skipped.length} selected item(s) (${reasons}). See Output › UMLMark for details.`
    );
}

async function openConfig(configUri: vscode.Uri): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(configUri);
    await vscode.window.showTextDocument(doc, { preview: false });
}

/** Info toast with a "Generate Now" action that hands the config to the existing generate command */
function offerGenerate(message: string, configUri: vscode.Uri): void {
    vscode.window.showInformationMessage(message, GENERATE_NOW).then(choice => {
        if (choice !== GENERATE_NOW) { return; }
        outputPanel.appendLine(`${LOG} generate-now config=${configUri.fsPath}`);
        vscode.commands.executeCommand(GENERATE_COMMAND, configUri);
    });
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

/** Write uml/ support files and, when the chosen target is new, the patched config */
async function materialize(spec: ConfigSpec, templateDir: string): Promise<{ target: ConfigTarget; effect: FileEffect }> {
    const umlDir = path.join(spec.workspaceRoot, UML_DIR);
    await fs.promises.mkdir(umlDir, { recursive: true });

    for (const name of SUPPORT_FILES) {
        const effect = await copyIfMissing(path.join(templateDir, name), path.join(umlDir, name));
        outputPanel.appendLine(`${LOG} support ${effect}: ${UML_DIR}/${name}`);
    }

    const chosen = await chooseTarget(spec);
    if (!chosen) {
        throw new Error(`no free config name among: ${spec.nameCandidates.join(', ')}`);
    }
    if (chosen.effect === 'exists-skip') { return chosen; }

    const templatePath = path.join(templateDir, spec.templateFile);
    const templateText = await fs.promises.readFile(templatePath, 'utf8');
    const header = buildHeaderLines({
        version: extensionVersion(),
        commandTitle: COMMAND_TITLES[spec.kind],
        createdIso: new Date().toISOString(),
        sources: spec.sources,
        entryRule: spec.entryRule,
    });
    const patched = patchTemplate(templateText, chosen.target.patch, header);
    if (isErr(patched)) {
        throw new Error(`${patched.error.message} (template: ${templatePath})`);
    }
    await fs.promises.writeFile(absolutePath(spec, chosen.target.configRelPath), patched.value, 'utf8');
    outputPanel.appendLine(`${LOG} patch ${JSON.stringify(chosen.target.patch)}`);
    return chosen;
}

async function createUmlGenConfig(kind: DiagramKind, clicked?: vscode.Uri, selected?: unknown): Promise<void> {
    const invocation = collectInvocation(clicked, selected);
    outputPanel.appendLine(
        `${LOG} invoke kind=${kind} source=${invocation.source} clicked=${clicked?.fsPath ?? '-'} selected=${invocation.uris.length}`
    );

    const entries = await Promise.all(invocation.uris.map(toSelectionEntry));
    const entry = await resolveEntry(kind, invocation);
    const planned = buildConfigSpec({ kind, entries, entry });
    if (isErr(planned)) {
        logSkipped(planned.error.skipped);
        outputPanel.appendLine(`${LOG} rejected code=${planned.error.code}`);
        vscode.window.showErrorMessage(`UMLMark: ${planned.error.message}`);
        return;
    }

    const spec = planned.value;
    logSkipped(spec.skipped);
    outputPanel.appendLine(
        `${LOG} plan language=${spec.language} workspace=${spec.workspaceRoot} ` +
        `candidates=${spec.nameCandidates.join(',')} include=${spec.patch.include.length}`
    );

    const templateDir = resolveTemplateDir();
    let result: { target: ConfigTarget; effect: FileEffect };
    try {
        result = await materialize(spec, templateDir);
    } catch (err) {
        outputPanel.appendLine(`${LOG} failed anchor=${spec.sources[0]} templateDir=${templateDir} error=${String(err)}`);
        vscode.window.showErrorMessage(`UMLMark: Failed to create the UMLGen config — ${String(err)}`);
        return;
    }
    const { target, effect } = result;
    outputPanel.appendLine(`${LOG} config ${effect}: ${target.configRelPath}`);

    const configUri = vscode.Uri.file(absolutePath(spec, target.configRelPath));
    await openConfig(configUri);
    warnSkipped(spec.skipped);

    if (effect === 'exists-skip') {
        // Q7: the existing config of the same source is opened untouched
        offerGenerate(`UMLMark: ${target.configRelPath} already exists — opened without changes.`, configUri);
        return;
    }

    // Q4: TypeScript configs are created for future tsc-gen / tss-gen support
    if (spec.language === 'typescript') {
        vscode.window.showWarningMessage(
            `UMLMark: Created ${target.configRelPath}. TypeScript generation is not yet supported by UMLGen; ` +
            `the config is ready for when it is.`
        );
        return;
    }

    // Q29: a qualified name means the plain name belongs to another source — say so
    const renamed = target.stem !== spec.nameCandidates[0] ? ` (${spec.nameCandidates[0]}.yaml belongs to another file)` : '';
    offerGenerate(
        `UMLMark: Created ${target.configRelPath} from ${spec.patch.include.length} file(s)${renamed}.`,
        configUri
    );
}

// ---------------------------------------------------------------------------
// VS Code commands
// ---------------------------------------------------------------------------

/** VS Code command: UMLMark: Create UMLGen Class Config */
export class CommandCreateUmlGenClassConfig extends Command {
    constructor() {
        super('umlmark.createUmlGenClassConfig');
    }

    execute(clicked?: vscode.Uri, selected?: unknown): Promise<void> {
        return createUmlGenConfig('class', clicked, selected);
    }
}

/** VS Code command: UMLMark: Create UMLGen Sequence Config */
export class CommandCreateUmlGenSequenceConfig extends Command {
    constructor() {
        super('umlmark.createUmlGenSequenceConfig');
    }

    execute(clicked?: vscode.Uri, selected?: unknown): Promise<void> {
        return createUmlGenConfig('sequence', clicked, selected);
    }
}
