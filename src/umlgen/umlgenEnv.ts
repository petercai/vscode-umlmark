'use strict';

/**
 * UMLGen runtime environment planning (C1 / Q23–Q27). Pure: no `vscode` import, no I/O.
 *
 * Produces (a) the list of filesystem checks the caller must verify before anything is sent
 * to a terminal and (b) the exact terminal command line. The caller owns the effects
 * (settings read, fs.stat, uv probe, terminal).
 *
 * Shell model: the dedicated "UMLGen" terminal is created with a known shell
 * (PowerShell on Windows, POSIX sh/bash elsewhere), so quoting and chaining are deterministic.
 */

import * as path from 'path';
import { Result } from './configSpec';

export type ShellKind = 'powershell' | 'posix';
export type Platform = 'win32' | 'posix';

/** Raw values of umlmark.umlgen.sourcePath / venvPath */
export interface EnvSettings {
    readonly sourcePath?: string;
    readonly venvPath?: string;
}

export type CheckId = 'source-pyproject' | 'venv-python' | 'venv-cli' | 'project-python';

/** A path that must exist; `label` is the user-facing description used in the warning */
export interface EnvCheck {
    readonly id: CheckId;
    readonly path: string;
    readonly label: string;
}

/** How the generator is launched */
export interface GenerationPlan {
    readonly sourcePath: string;
    readonly venvPath: string;
    /** 'project' = Python project venv with UMLGen installed on every run (Q25); else the UMLGen venv */
    readonly pythonEnv: 'project' | 'umlgen-venv' | 'n/a';
    readonly cliPath: string;
    /** Present when UMLGen must be (re)installed into the project env first (Python, Q25) */
    readonly installInto?: string;
    readonly checks: readonly EnvCheck[];
}

export interface EnvError {
    readonly code: 'not-configured';
    readonly message: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Expand a leading "~" to the home directory (Q23) */
export function expandHome(p: string, home: string): string {
    return p.replace(/^~(?=$|[\\/])/, home);
}

/** Executable inside a venv: Scripts\name.exe on Windows, bin/name elsewhere */
export function venvExecutable(venv: string, name: string, platform: Platform): string {
    return platform === 'win32'
        ? path.win32.join(venv, 'Scripts', `${name}.exe`)
        : path.posix.join(venv, 'bin', name);
}

/** Project venv folders probed for Python projects, in order (Q25) */
export function projectEnvCandidates(workspaceRoot: string): string[] {
    return ['.venv', 'venv'].map(d => path.join(workspaceRoot, d));
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * Resolve settings and decide how to run `cliName`.
 *
 * @param projectEnv first existing project venv (Python only), resolved by the caller
 */
export function planGeneration(input: {
    readonly settings: EnvSettings;
    readonly home: string;
    readonly platform: Platform;
    readonly language: string;
    readonly cliName: string;
    readonly projectEnv?: string;
}): Result<GenerationPlan, EnvError> {
    const rawSource = input.settings.sourcePath?.trim();
    if (!rawSource) {
        return {
            ok: false,
            error: {
                code: 'not-configured',
                message: 'UMLGen is not configured: set "umlmark.umlgen.sourcePath" to your uml-gen checkout.',
            },
        };
    }
    const sourcePath = expandHome(rawSource, input.home);
    const rawVenv = input.settings.venvPath?.trim();
    const venvPath = rawVenv ? expandHome(rawVenv, input.home) : path.join(sourcePath, '.venv');

    const baseChecks: EnvCheck[] = [
        { id: 'source-pyproject', path: path.join(sourcePath, 'pyproject.toml'), label: 'uml-gen checkout (pyproject.toml)' },
        { id: 'venv-python', path: venvExecutable(venvPath, 'python', input.platform), label: 'UMLGen venv Python' },
    ];

    // Python with a project venv: install UMLGen there and run it with the project's Python (Q25)
    if (input.language === 'python' && input.projectEnv) {
        const projectPython = venvExecutable(input.projectEnv, 'python', input.platform);
        return {
            ok: true,
            value: {
                sourcePath,
                venvPath,
                pythonEnv: 'project',
                cliPath: venvExecutable(input.projectEnv, input.cliName, input.platform),
                installInto: projectPython,
                checks: [...baseChecks, { id: 'project-python', path: projectPython, label: 'project venv Python' }],
            },
        };
    }

    // Java (and Python without a project venv): run the CLI from the UMLGen venv by absolute path (Q24)
    const cliPath = venvExecutable(venvPath, input.cliName, input.platform);
    return {
        ok: true,
        value: {
            sourcePath,
            venvPath,
            pythonEnv: input.language === 'python' ? 'umlgen-venv' : 'n/a',
            cliPath,
            checks: [...baseChecks, { id: 'venv-cli', path: cliPath, label: `${input.cliName} in the UMLGen venv` }],
        },
    };
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/** Single-quoted literal: no variable expansion in either shell */
export function quote(arg: string, shell: ShellKind): string {
    return shell === 'powershell'
        ? `'${arg.replace(/'/g, "''")}'`
        : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Invoke an executable by path (PowerShell needs the call operator for a quoted path) */
function invoke(exe: string, args: readonly string[], shell: ShellKind): string {
    const head = shell === 'powershell' ? `& ${quote(exe, shell)}` : quote(exe, shell);
    return [head, ...args.map(a => quote(a, shell))].join(' ');
}

/** Run each step only if the previous succeeded (Windows PowerShell 5 has no "&&") */
function chain(steps: readonly string[], shell: ShellKind): string {
    if (shell === 'posix') { return steps.join(' && '); }
    return steps.reduceRight((rest, step) => (rest ? `${step}; if ($?) { ${rest} }` : step), '');
}

/**
 * Full terminal command: cd to the workspace (relative config paths), optional install, generate.
 *
 * @param installer 'uv' when `uv` is on PATH, otherwise pip through the project Python
 */
export function buildTerminalCommand(input: {
    readonly shell: ShellKind;
    readonly workspaceRoot: string;
    readonly plan: GenerationPlan;
    readonly configRelPath: string;
    readonly installer: 'uv' | 'pip';
}): string {
    const { shell, plan } = input;
    const cd = shell === 'powershell'
        ? `Set-Location -LiteralPath ${quote(input.workspaceRoot, shell)}`
        : `cd ${quote(input.workspaceRoot, shell)}`;
    const install = !plan.installInto ? [] : [
        input.installer === 'uv'
            ? ['uv', 'pip', 'install', '-q', '--python', quote(plan.installInto, shell), '-e', quote(plan.sourcePath, shell)].join(' ')
            : invoke(plan.installInto, ['-m', 'pip', 'install', '-q', '-e', plan.sourcePath], shell),
    ];
    const run = invoke(plan.cliPath, ['--config', input.configRelPath], shell);
    return chain([cd, ...install, run], shell);
}
