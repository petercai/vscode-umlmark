'use strict';

/**
 * Pure planning logic for "Create UMLGen Class/Sequence Config".
 *
 * Turns a raw selection (file-system entries) into an immutable ConfigSpec that
 * describes exactly which config to create and how to patch the template.
 * No `vscode` import and no I/O, so it is unit-testable under plain Node.
 *
 * Decisions: docs/umlgen/umlgen-config-gen-GRILLING-2026-10-04-en.md
 */

import * as path from 'path';

export type DiagramKind = 'class' | 'sequence';
export type SourceLanguage = 'python' | 'java' | 'typescript';

/** One selected item, already classified by the effectful caller (stat + workspace lookup). */
export interface SelectionEntry {
    readonly fsPath: string;
    readonly entryType: 'file' | 'directory' | 'missing';
    /** fsPath of the owning workspace folder; undefined when outside every folder */
    readonly workspaceRoot?: string;
}

export type SkipReason =
    | 'folder'            // Q10: folders are ignored, no recursive expansion
    | 'not-on-disk'       // untitled / virtual documents cannot be referenced by the CLI
    | 'unsupported-ext'   // Q10: only .py / .java / .ts
    | 'other-language'    // Q9: first file's language wins
    | 'other-workspace'   // Q14: first file's workspace folder wins
    | 'outside-workspace';

export interface SkippedEntry {
    readonly fsPath: string;
    readonly reason: SkipReason;
}

/** Cursor-aware sequence entry for the anchor file (Q18-B / Q30), built by ./entryRule */
export interface EntryRule {
    /** Include rule, e.g. "adapters/engine.py:Engine.clean" or "src/main/java/Foo.java:run" */
    readonly rule: string;
    /** Name part appended to the config stem (Q31), e.g. "clean" → engine-clean-seq.yaml */
    readonly nameSuffix: string;
}

export interface ConfigSpec {
    readonly kind: DiagramKind;
    readonly language: SourceLanguage;
    readonly workspaceRoot: string;
    /** Accepted workspace-relative POSIX source paths; [0] is the anchor (recorded in the header, C3) */
    readonly sources: readonly string[];
    /** Present only for a cursor-aware entry (recorded in the header as "Entry:") */
    readonly entryRule?: string;
    /**
     * Config stems in preference order (Q29 / Q8-B): plain name first, then names qualified
     * with parent folders, finally with the workspace folder name. The caller picks the first
     * stem that is free or already owned by the same source.
     */
    readonly nameCandidates: readonly string[];
    /** Bundled template file name for this diagram kind */
    readonly templateFile: string;
    /** Values written into the template; output.path is derived from the chosen stem (targetFor) */
    readonly patch: Omit<ConfigPatch, 'outputPath'>;
    readonly skipped: readonly SkippedEntry[];
}

/** Concrete target for one chosen stem */
export interface ConfigTarget {
    readonly stem: string;
    readonly configRelPath: string;
    readonly patch: ConfigPatch;
}

export interface ConfigPatch {
    readonly diagramType: DiagramKind;
    readonly language: SourceLanguage;
    /** Only set when it must differ from the template (Q21: Python → ast) */
    readonly parser?: 'ast';
    readonly outputPath: string;
    readonly srcRoot: readonly string[];
    readonly include: readonly string[];
}

export type ConfigSpecErrorCode = 'no-selection' | 'no-supported-file';

export interface ConfigSpecError {
    readonly code: ConfigSpecErrorCode;
    readonly message: string;
    readonly skipped: readonly SkippedEntry[];
}

export interface Ok<T> { readonly ok: true; readonly value: T }
export interface Err<E> { readonly ok: false; readonly error: E }
export type Result<T, E> = Ok<T> | Err<E>;

/** Type guard: boolean discriminants do not narrow without strictNullChecks, so narrow explicitly */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
    return !result.ok;
}

// ---------------------------------------------------------------------------
// Constants (immutable tables)
// ---------------------------------------------------------------------------

/** Workspace folder that receives generated configs and shared support files */
export const UML_DIR = 'uml';

/** Support files copied once into uml/ (never overwritten) */
export const SUPPORT_FILES: readonly string[] = ['filter-v3.yaml', 'parsers.lock.yaml'];

const LANGUAGE_BY_EXT: Readonly<Record<string, SourceLanguage>> = {
    '.py': 'python',
    '.java': 'java',
    '.ts': 'typescript',
};

const KIND_TRAITS: Readonly<Record<DiagramKind, { suffix: string; template: string }>> = {
    class: { suffix: 'cls', template: 'umlc-gen-v3.yaml' },
    sequence: { suffix: 'seq', template: 'umls-gen-v3.yaml' },
};

/** Maven/Gradle source root marker used for Java src_root inference (Q12) */
const JAVA_SRC_ROOT_RE = /^(?:(.*)\/)?src\/main\/java\//;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

export function languageOf(fsPath: string): SourceLanguage | undefined {
    return LANGUAGE_BY_EXT[path.extname(fsPath).toLowerCase()];
}

/** Workspace-relative path with forward slashes on every OS */
export function toPosixRelative(workspaceRoot: string, fsPath: string): string {
    return path.relative(workspaceRoot, fsPath).split(path.sep).join('/');
}

/**
 * Include-rule form (Q19 / F11): the CLI treats a rule as a file path only when it
 * contains "/" or "*", or ends with ".java". Workspace-root .py/.ts files therefore
 * get a "./" prefix, otherwise they would be read as class short names.
 */
export function toIncludeRule(relPosix: string): string {
    const isFileRule = relPosix.includes('/') || relPosix.endsWith('.java');
    return isFileRule ? relPosix : `./${relPosix}`;
}

/** src_root inference (Q12): Python/TS → ".", Java → prefix up to src/main/java or "." */
export function inferSrcRoot(language: SourceLanguage, firstRelPosix: string): string {
    if (language !== 'java') { return '.'; }
    const match = JAVA_SRC_ROOT_RE.exec(firstRelPosix);
    if (!match) { return '.'; }
    return match[1] ? `${match[1]}/src/main/java` : 'src/main/java';
}

/** Remove duplicate paths while keeping first-seen order (clicked URI is often also in the selection) */
function uniqueByPath(entries: readonly SelectionEntry[]): SelectionEntry[] {
    const seen = new Set<string>();
    return entries.filter(e => {
        const key = path.normalize(e.fsPath);
        if (seen.has(key)) { return false; }
        seen.add(key);
        return true;
    });
}

/** Reason an entry can never contribute, independent of the anchor file; undefined = candidate */
function intrinsicSkipReason(entry: SelectionEntry): SkipReason | undefined {
    if (entry.entryType === 'directory') { return 'folder'; }
    if (entry.entryType === 'missing') { return 'not-on-disk'; }
    if (!languageOf(entry.fsPath)) { return 'unsupported-ext'; }
    if (!entry.workspaceRoot) { return 'outside-workspace'; }
    return undefined;
}

/** Keep generated file names portable: anything outside [A-Za-z0-9._-] becomes "_" */
function safeNamePart(part: string): string {
    return part.replace(/[^A-Za-z0-9._-]+/g, '_');
}

/**
 * Config stem candidates (Q29): `<tail>`, `<parent>-<tail>`, `<grandparent>-<parent>-<tail>`, …,
 * ending with the workspace folder name so a workspace-root file can still be qualified.
 */
export function nameCandidates(anchorRel: string, workspaceName: string, tail: string): string[] {
    const qualifiers = [...anchorRel.split('/').slice(0, -1).reverse(), workspaceName].map(safeNamePart);
    return [tail, ...qualifiers.map((_, i) => [...qualifiers.slice(0, i + 1).reverse(), tail].join('-'))];
}

/** Resolve the config path and the full patch (output.path) for a chosen stem */
export function targetFor(spec: ConfigSpec, stem: string): ConfigTarget {
    return {
        stem,
        configRelPath: `${UML_DIR}/${stem}.yaml`,
        patch: { ...spec.patch, outputPath: `${UML_DIR}/${stem}.puml` },
    };
}

/** Normalise a source path for identity comparison ("./a.py", "a\b.py" → "a.py", "a/b.py") */
export function normalizeSource(source: string): string {
    return source.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Q29 identity rule: an existing config belongs to the same source when its recorded source
 * equals the anchor. Unknown provenance counts as "same" so an existing file is never overwritten.
 */
export function isSameSource(existingSource: string | undefined, anchorRel: string): boolean {
    return existingSource === undefined || normalizeSource(existingSource) === normalizeSource(anchorRel);
}

// ---------------------------------------------------------------------------
// Main planner
// ---------------------------------------------------------------------------

/**
 * Build the ConfigSpec for a selection.
 *
 * The first supported file is the anchor: it fixes the language (Q9), the workspace
 * folder (Q14) and the config name. Every other entry is accepted or skipped with a reason.
 */
export function buildConfigSpec(input: {
    readonly kind: DiagramKind;
    readonly entries: readonly SelectionEntry[];
    /** Cursor-aware entry for the anchor file (sequence + editor invocation only) */
    readonly entry?: EntryRule;
}): Result<ConfigSpec, ConfigSpecError> {
    const entries = uniqueByPath(input.entries);
    if (entries.length === 0) {
        return { ok: false, error: { code: 'no-selection', message: 'No file selected.', skipped: [] } };
    }

    const intrinsic = entries.map(entry => ({ entry, reason: intrinsicSkipReason(entry) }));
    const anchor = intrinsic.find(x => x.reason === undefined)?.entry;
    if (!anchor) {
        const skipped = intrinsic.map(x => ({ fsPath: x.entry.fsPath, reason: x.reason as SkipReason }));
        return {
            ok: false,
            error: {
                code: 'no-supported-file',
                message: 'Select at least one .py, .java or .ts file inside a workspace folder.',
                skipped,
            },
        };
    }

    const language = languageOf(anchor.fsPath) as SourceLanguage;
    const workspaceRoot = anchor.workspaceRoot as string;

    // Classify every entry relative to the anchor (pure mapping, no mutation)
    const classified = intrinsic.map(({ entry, reason }) => {
        if (reason) { return { entry, reason }; }
        if (path.normalize(entry.workspaceRoot as string) !== path.normalize(workspaceRoot)) {
            return { entry, reason: 'other-workspace' as SkipReason };
        }
        if (languageOf(entry.fsPath) !== language) {
            return { entry, reason: 'other-language' as SkipReason };
        }
        return { entry, reason: undefined };
    });

    const acceptedRel = classified
        .filter(x => x.reason === undefined)
        .map(x => toPosixRelative(workspaceRoot, x.entry.fsPath));
    const skipped = classified
        .filter(x => x.reason !== undefined)
        .map(x => ({ fsPath: x.entry.fsPath, reason: x.reason as SkipReason }));

    const traits = KIND_TRAITS[input.kind];
    const baseName = path.basename(anchor.fsPath, path.extname(anchor.fsPath));
    // Q31: a cursor-aware entry gets its own config, e.g. engine-clean-seq
    const tail = [baseName, input.entry?.nameSuffix, traits.suffix].filter(Boolean).map(p => safeNamePart(p as string)).join('-');
    // Q30: the entry rule replaces the anchor's whole-file rule; other selected files stay whole-file
    const include = acceptedRel.map((rel, i) => (i === 0 && input.entry ? input.entry.rule : toIncludeRule(rel)));

    return {
        ok: true,
        value: {
            kind: input.kind,
            language,
            workspaceRoot,
            sources: acceptedRel,
            entryRule: input.entry?.rule,
            nameCandidates: nameCandidates(acceptedRel[0], path.basename(workspaceRoot), tail),
            templateFile: traits.template,
            patch: {
                diagramType: input.kind,
                language,
                parser: language === 'python' ? 'ast' : undefined,
                srcRoot: [inferSrcRoot(language, acceptedRel[0])],
                include,
            },
            skipped,
        },
    };
}
