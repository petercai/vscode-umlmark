import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import {
    buildConfigSpec, ConfigSpec, EntryRule, isErr, isSameSource, nameCandidates, SelectionEntry, targetFor,
} from '../src/umlgen/configSpec';
import { patchTemplate } from '../src/umlgen/configPatch';
import { buildHeaderLines, readConfigSource } from '../src/umlgen/configHeader';
import { entryRuleFor } from '../src/umlgen/entryRule';
import { buildTerminalCommand, expandHome, GenerationPlan, planGeneration } from '../src/umlgen/umlgenEnv';

// Absolute, OS-native workspace roots so path.relative behaves as in VS Code on every platform
const WS = path.resolve('/ws/app');
const WS_OTHER = path.resolve('/ws/other');
const TEMPLATE_DIR = path.resolve(__dirname, '..', '..', 'umlgen'); // out/test → repo root

const file = (rel: string, root: string = WS): SelectionEntry =>
    ({ fsPath: path.join(root, ...rel.split('/')), entryType: 'file', workspaceRoot: root });

function plan(kind: 'class' | 'sequence', entries: SelectionEntry[], entry?: EntryRule): ConfigSpec {
    const result = buildConfigSpec({ kind, entries, entry });
    if (isErr(result)) { throw new Error(`expected a plan, got ${JSON.stringify(result.error)}`); }
    return result.value;
}

/** Target for the preferred (first) name candidate */
const firstTarget = (spec: ConfigSpec) => targetFor(spec, spec.nameCandidates[0]);

// ---------------------------------------------------------------------------
// configSpec — planning (iteration 1 behaviour)
// ---------------------------------------------------------------------------

function testPythonRootFileGetsDotSlashAndAstParser(): void {
    const spec = plan('class', [file('engine.py')]);
    const target = firstTarget(spec);

    assert.strictEqual(target.configRelPath, 'uml/engine-cls.yaml');
    assert.strictEqual(spec.templateFile, 'umlc-gen-v3.yaml');
    assert.deepStrictEqual(target.patch, {
        diagramType: 'class',
        language: 'python',
        parser: 'ast',
        outputPath: 'uml/engine-cls.puml',
        srcRoot: ['.'],
        include: ['./engine.py'], // F11: bare root file would be read as a class name
    });
}

function testJavaMultiModuleInfersSrcRootAndKeepsParser(): void {
    const spec = plan('sequence', [file('module-x/src/main/java/com/acme/FeedService.java')]);

    assert.strictEqual(firstTarget(spec).configRelPath, 'uml/FeedService-seq.yaml');
    assert.strictEqual(spec.patch.parser, undefined, 'Q21: Java keeps template parser');
    assert.deepStrictEqual(spec.patch.srcRoot, ['module-x/src/main/java']);
    assert.deepStrictEqual(spec.patch.include, ['module-x/src/main/java/com/acme/FeedService.java']);
}

function testJavaRootLevelSrcMainJavaAndNonMaven(): void {
    assert.deepStrictEqual(plan('class', [file('src/main/java/A.java')]).patch.srcRoot, ['src/main/java']);
    assert.deepStrictEqual(plan('class', [file('lib/A.java')]).patch.srcRoot, ['.']);
    // A root-level .java file is already a file rule for the CLI → no ./ prefix
    assert.deepStrictEqual(plan('class', [file('A.java')]).patch.include, ['A.java']);
}

function testMultiSelectionFirstFileWinsAndSkipsAreReported(): void {
    const spec = plan('class', [
        { fsPath: path.join(WS, 'adapters'), entryType: 'directory', workspaceRoot: WS },
        file('adapters/engine.py'),
        file('adapters/engine.py'),            // duplicate (clicked + selected)
        file('adapters/rules.py'),
        file('adapters/Feed.java'),            // other language
        file('README.md'),                     // unsupported
        file('tools/x.py', WS_OTHER),          // other workspace folder
    ]);

    assert.strictEqual(firstTarget(spec).configRelPath, 'uml/engine-cls.yaml');
    assert.deepStrictEqual(spec.sources, ['adapters/engine.py', 'adapters/rules.py']);
    assert.deepStrictEqual(spec.patch.include, ['adapters/engine.py', 'adapters/rules.py']);
    assert.deepStrictEqual(
        spec.skipped.map(s => s.reason),
        ['folder', 'other-language', 'unsupported-ext', 'other-workspace'],
    );
}

function testTypeScriptIsPlannedWithTemplateParser(): void {
    const spec = plan('class', [file('src/app.ts')]);
    assert.strictEqual(spec.language, 'typescript');
    assert.strictEqual(spec.patch.parser, undefined);
    assert.deepStrictEqual(spec.patch.srcRoot, ['.']);
}

function testRejectsSelectionsWithoutSupportedFiles(): void {
    const empty = buildConfigSpec({ kind: 'class', entries: [] });
    assert.ok(isErr(empty) && empty.error.code === 'no-selection');

    const none = buildConfigSpec({
        kind: 'class',
        entries: [
            file('README.md'),
            { fsPath: path.join(WS, 'x.py'), entryType: 'missing', workspaceRoot: WS },
            { fsPath: path.resolve('/tmp/y.py'), entryType: 'file' },
        ],
    });
    if (!isErr(none)) { throw new Error('expected rejection'); }
    assert.strictEqual(none.error.code, 'no-supported-file');
    assert.deepStrictEqual(
        none.error.skipped.map(s => s.reason),
        ['unsupported-ext', 'not-on-disk', 'outside-workspace'],
    );
}

// ---------------------------------------------------------------------------
// Q8-B / Q29 — collision-aware naming
// ---------------------------------------------------------------------------

function testNameCandidatesQualifyWithParentsThenWorkspace(): void {
    assert.deepStrictEqual(
        nameCandidates('adapters/htmlclean/engine.py', 'app', 'engine-cls'),
        ['engine-cls', 'htmlclean-engine-cls', 'adapters-htmlclean-engine-cls', 'app-adapters-htmlclean-engine-cls'],
    );
    // Workspace-root file can still be qualified by the workspace folder name
    assert.deepStrictEqual(nameCandidates('engine.py', 'my app', 'engine-cls'), ['engine-cls', 'my_app-engine-cls']);
    assert.deepStrictEqual(plan('class', [file('a/b/engine.py')]).nameCandidates.slice(0, 2), ['engine-cls', 'b-engine-cls']);
}

function testSameSourceRule(): void {
    assert.ok(isSameSource('./engine.py', 'engine.py'));
    assert.ok(isSameSource('a\\b.py', 'a/b.py'));
    assert.ok(isSameSource(undefined, 'a/b.py'), 'unknown provenance → same (never overwrite)');
    assert.ok(!isSameSource('a/engine.py', 'b/engine.py'));
}

// ---------------------------------------------------------------------------
// C3 / Q28 — header
// ---------------------------------------------------------------------------

function testHeaderRoundTripAndIncludeFallback(): void {
    const lines = buildHeaderLines({
        version: '1.0.8',
        commandTitle: 'Create UMLGen Sequence Config',
        createdIso: '2026-10-04T23:10:00.000Z',
        sources: ['adapters/engine.py', 'adapters/rules.py'],
        entryRule: 'adapters/engine.py:Engine.clean',
    });
    assert.strictEqual(lines[0], '# Generated by UMLMark 1.0.8 — Create UMLGen Sequence Config');
    assert.ok(lines.includes('#   - adapters/rules.py'));
    assert.strictEqual(lines[lines.length - 1], '# Entry: adapters/engine.py:Engine.clean');
    assert.strictEqual(readConfigSource(lines.join('\r\n') + '\r\nversion: 3\r\n'), 'adapters/engine.py');

    // No header: first path-like include rule (method part stripped); class names give no identity
    assert.strictEqual(readConfigSource('include:\n  - ./engine.py:Engine.run\n'), './engine.py');
    assert.strictEqual(readConfigSource('include:\n  - CategoryController\n'), undefined);
    assert.strictEqual(readConfigSource('include: [unclosed'), undefined);
}

// ---------------------------------------------------------------------------
// Q18-B / Q30 / Q31 — cursor-aware entry
// ---------------------------------------------------------------------------

function testEntryRuleForPythonJavaAndTs(): void {
    const method = [{ kind: 'class' as const, name: 'Engine' }, { kind: 'method' as const, name: 'clean' }];

    assert.deepStrictEqual(entryRuleFor('python', 'a/engine.py', method), { rule: 'a/engine.py:Engine.clean', nameSuffix: 'clean' });
    assert.deepStrictEqual(entryRuleFor('python', 'engine.py', [{ kind: 'function', name: 'main' }]),
        { rule: './engine.py:main', nameSuffix: 'main' });
    assert.deepStrictEqual(entryRuleFor('python', 'a/engine.py', [{ kind: 'class', name: 'Engine' }]),
        { rule: 'a/engine.py:Engine.*', nameSuffix: 'Engine' });
    // Nested helper inside a method → the outermost callable is the CLI-addressable entry
    assert.deepStrictEqual(entryRuleFor('python', 'a/e.py', [...method, { kind: 'function', name: 'inner' }]),
        { rule: 'a/e.py:Engine.clean', nameSuffix: 'clean' });
    // F12: Java uses the bare method name; class body without method → whole file
    assert.deepStrictEqual(entryRuleFor('java', 'src/main/java/Feed.java', [{ kind: 'class', name: 'Feed' }, { kind: 'method', name: 'run' }]),
        { rule: 'src/main/java/Feed.java:run', nameSuffix: 'run' });
    assert.strictEqual(entryRuleFor('java', 'Feed.java', [{ kind: 'class', name: 'Feed' }]), undefined);
    assert.deepStrictEqual(entryRuleFor('typescript', 'src/a.ts', method), { rule: 'src/a.ts:Engine.clean', nameSuffix: 'clean' });
    assert.strictEqual(entryRuleFor('python', 'a.py', []), undefined);
}

function testEntryRuleDrivesIncludeAndName(): void {
    const entry = entryRuleFor('python', 'a/engine.py', [{ kind: 'class', name: 'Engine' }, { kind: 'method', name: 'clean' }]);
    const spec = plan('sequence', [file('a/engine.py')], entry);
    const target = firstTarget(spec);

    assert.strictEqual(target.configRelPath, 'uml/engine-clean-seq.yaml', 'Q31');
    assert.strictEqual(target.patch.outputPath, 'uml/engine-clean-seq.puml');
    assert.deepStrictEqual(spec.patch.include, ['a/engine.py:Engine.clean']);
    assert.strictEqual(spec.entryRule, 'a/engine.py:Engine.clean');
}

// ---------------------------------------------------------------------------
// configPatch — real templates
// ---------------------------------------------------------------------------

/** Patch the real bundled templates and check values, cleanup, header and comment preservation */
function testPatchRealTemplates(): void {
    const cases: Array<[string, ConfigSpec]> = [
        ['umlc-gen-v3.yaml', plan('class', [file('adapters/engine.py'), file('adapters/rules.py')])],
        ['umls-gen-v3.yaml', plan('sequence', [file('module-x/src/main/java/com/acme/FeedService.java')])],
    ];

    for (const [template, spec] of cases) {
        const target = firstTarget(spec);
        const text = fs.readFileSync(path.join(TEMPLATE_DIR, template), 'utf8');
        const header = buildHeaderLines({
            version: '9.9.9', commandTitle: 't', createdIso: 'now', sources: spec.sources,
        });
        const result = patchTemplate(text, target.patch, header);
        if (isErr(result)) { throw new Error(`${template}: ${result.error.message}`); }
        const out = result.value;
        const data = parse(out);

        assert.strictEqual(data.diagram.type, spec.kind, `${template}: diagram.type`);
        assert.strictEqual(data.runtime.language, spec.language);
        assert.strictEqual(data.runtime.parser, spec.patch.parser ?? 'tree-sitter');
        assert.strictEqual(data.output.path, target.patch.outputPath);
        assert.deepStrictEqual(data.src_root, spec.patch.srcRoot);
        assert.deepStrictEqual(data.include, spec.patch.include);
        assert.deepStrictEqual(data.exclude, [], 'Q17: template exclude samples removed');
        assert.deepStrictEqual(data.import, ['uml/filter-v3.yaml'], 'import untouched');
        assert.strictEqual(data.runtime.parser_lock_file, 'uml/parsers.lock.yaml');
        // Q11: explanatory comments survive the patch
        assert.ok(out.includes('# class | sequence'), `${template}: diagram comment preserved`);
        assert.ok(out.includes('Directories always skipped'), `${template}: trailing list comment carried over`);
        assert.strictEqual(out.includes('\r\n'), text.includes('\r\n'), `${template}: line endings follow template`);
        assert.ok(!/^\s*-\s*CategoryController/m.test(out) && !/^\s*-\s*FeedRefreshTaskGiver/m.test(out),
            `${template}: example include entries removed`);
        // C3: header on top, and it identifies the source for Q29
        assert.ok(out.startsWith('# Generated by UMLMark 9.9.9'), `${template}: header first`);
        assert.strictEqual(readConfigSource(out), spec.sources[0]);
    }
}

function testPatchRejectsInvalidYaml(): void {
    const patch = firstTarget(plan('class', [file('a.py')])).patch;
    assert.ok(!patchTemplate('a: [unclosed', patch).ok);
    assert.ok(!patchTemplate('- just\n- a list\n', patch).ok);
}

// ---------------------------------------------------------------------------
// C1 / Q23–Q27 — UMLGen environment plan and terminal command
// ---------------------------------------------------------------------------

function testPlanRequiresSourcePath(): void {
    const result = planGeneration({ settings: {}, home: '/h', platform: 'posix', language: 'java', cliName: 'umlc-gen' });
    assert.ok(isErr(result) && result.error.code === 'not-configured');
    assert.strictEqual(expandHome('~/src/uml-gen', '/h'), '/h/src/uml-gen');
    assert.strictEqual(expandHome('/x/~y', '/h'), '/x/~y');
}

function testPlanJavaRunsFromUmlGenVenv(): void {
    const result = planGeneration({
        settings: { sourcePath: '/opt/uml-gen' }, home: '/h', platform: 'posix', language: 'java', cliName: 'umls-gen',
    });
    if (isErr(result)) { throw new Error(result.error.message); }
    const p = result.value;
    assert.strictEqual(p.venvPath, path.join('/opt/uml-gen', '.venv'), 'Q23: venv defaults to <source>/.venv');
    assert.ok(p.cliPath.endsWith('/bin/umls-gen'));
    assert.strictEqual(p.installInto, undefined);
    assert.deepStrictEqual(p.checks.map(c => c.id), ['source-pyproject', 'venv-python', 'venv-cli']);
}

function testPlanPythonUsesProjectEnvOnWindows(): void {
    const result = planGeneration({
        settings: { sourcePath: 'C:\\src\\uml-gen', venvPath: 'C:\\envs\\umlgen' }, home: 'C:\\Users\\me',
        platform: 'win32', language: 'python', cliName: 'pyc-gen', projectEnv: 'C:\\ws\\.venv',
    });
    if (isErr(result)) { throw new Error(result.error.message); }
    const p = result.value;
    assert.strictEqual(p.pythonEnv, 'project');
    assert.strictEqual(p.cliPath, 'C:\\ws\\.venv\\Scripts\\pyc-gen.exe');
    assert.strictEqual(p.installInto, 'C:\\ws\\.venv\\Scripts\\python.exe');
    assert.deepStrictEqual(p.checks.map(c => c.id), ['source-pyproject', 'venv-python', 'project-python']);

    const noProject = planGeneration({
        settings: { sourcePath: '/opt/uml-gen' }, home: '/h', platform: 'posix', language: 'python', cliName: 'pyc-gen',
    });
    assert.ok(!isErr(noProject) && noProject.value.pythonEnv === 'umlgen-venv' && !noProject.value.installInto);
}

function testTerminalCommandPerShell(): void {
    const plan: GenerationPlan = {
        sourcePath: "/opt/it's/uml-gen", venvPath: '/v', pythonEnv: 'project',
        cliPath: '/ws/.venv/bin/pyc-gen', installInto: '/ws/.venv/bin/python', checks: [],
    };
    const posix = buildTerminalCommand({ shell: 'posix', workspaceRoot: '/ws', plan, configRelPath: 'uml/a-cls.yaml', installer: 'uv' });
    assert.strictEqual(posix,
        "cd '/ws' && uv pip install -q --python '/ws/.venv/bin/python' -e '/opt/it'\\''s/uml-gen' && " +
        "'/ws/.venv/bin/pyc-gen' '--config' 'uml/a-cls.yaml'");

    const winPlan: GenerationPlan = { ...plan, sourcePath: 'C:\\src\\uml-gen', cliPath: 'C:\\v\\Scripts\\umlc-gen.exe', installInto: undefined };
    const ps = buildTerminalCommand({ shell: 'powershell', workspaceRoot: 'C:\\my ws', plan: winPlan, configRelPath: 'uml/A-cls.yaml', installer: 'uv' });
    assert.strictEqual(ps,
        "Set-Location -LiteralPath 'C:\\my ws'; if ($?) { & 'C:\\v\\Scripts\\umlc-gen.exe' '--config' 'uml/A-cls.yaml' }");

    const pip = buildTerminalCommand({ shell: 'powershell', workspaceRoot: 'C:\\ws', plan: { ...plan, installInto: 'C:\\ws\\.venv\\Scripts\\python.exe' }, configRelPath: 'u.yaml', installer: 'pip' });
    assert.ok(pip.includes("& 'C:\\ws\\.venv\\Scripts\\python.exe' '-m' 'pip' 'install' '-q' '-e'"), pip);
    assert.strictEqual((pip.match(/if \(\$\?\)/g) ?? []).length, 2, 'each step gated on the previous one');
}

[
    testPythonRootFileGetsDotSlashAndAstParser,
    testJavaMultiModuleInfersSrcRootAndKeepsParser,
    testJavaRootLevelSrcMainJavaAndNonMaven,
    testMultiSelectionFirstFileWinsAndSkipsAreReported,
    testTypeScriptIsPlannedWithTemplateParser,
    testRejectsSelectionsWithoutSupportedFiles,
    testNameCandidatesQualifyWithParentsThenWorkspace,
    testSameSourceRule,
    testHeaderRoundTripAndIncludeFallback,
    testEntryRuleForPythonJavaAndTs,
    testEntryRuleDrivesIncludeAndName,
    testPatchRealTemplates,
    testPatchRejectsInvalidYaml,
    testPlanRequiresSourcePath,
    testPlanJavaRunsFromUmlGenVenv,
    testPlanPythonUsesProjectEnvOnWindows,
    testTerminalCommandPerShell,
].forEach(t => {
    t();
    console.log(`[test] ${t.name} passed`);
});
console.log('[test] umlgen-config.node.test passed');
