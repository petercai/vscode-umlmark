'use strict';

/**
 * Comment-preserving patch of a UMLGen v3 template (Q11).
 *
 * Uses the `yaml` Document API so the template's explanatory comments, key order
 * and blank lines survive; only the targeted values are replaced.
 * Pure: text in, text out. No `vscode` import.
 */

import { parseDocument, Document, isMap } from 'yaml';
import { ConfigPatch, Result } from './configSpec';

export interface PatchError {
    readonly message: string;
}

/**
 * Replace a key's value with a block sequence (or `[]` flow when empty).
 *
 * The old node's trailing comment is carried over: the parser attaches the comment
 * block that follows a list (usage hints, the "Generated section" note before
 * `matched:`) to that list, so dropping the node would silently drop those comments.
 */
function setSequence(doc: Document, key: string, items: readonly string[]): void {
    const previous = doc.get(key, true) as { comment?: string | null } | undefined;
    const node = doc.createNode([...items]) as { flow?: boolean; comment?: string | null };
    // Empty list renders as `key: []` instead of a dangling `key:`
    node.flow = items.length === 0;
    node.comment = previous?.comment;
    doc.set(key, node);
}

/**
 * Apply the patch values to template text.
 * Returns the new YAML text, or an error when the template is not a valid YAML mapping.
 *
 * @param headerLines provenance comment lines (C3) placed above the template's own header
 */
export function patchTemplate(
    templateText: string,
    patch: ConfigPatch,
    headerLines: readonly string[] = [],
): Result<string, PatchError> {
    const doc = parseDocument(templateText);
    if (doc.errors.length > 0) {
        return { ok: false, error: { message: `Template YAML is invalid: ${doc.errors[0].message}` } };
    }
    if (!isMap(doc.contents)) {
        return { ok: false, error: { message: 'Template YAML root is not a mapping.' } };
    }

    doc.setIn(['diagram', 'type'], patch.diagramType);
    doc.setIn(['runtime', 'language'], patch.language);
    // Q21: only Python overrides the template parser; Java/TS keep the template default
    if (patch.parser) {
        doc.setIn(['runtime', 'parser'], patch.parser);
    }
    doc.setIn(['output', 'path'], patch.outputPath);
    setSequence(doc, 'src_root', patch.srcRoot);
    setSequence(doc, 'include', patch.include);
    // Q17: template exclude samples are illustrative only; shared excludes live in uml/filter-v3.yaml
    setSequence(doc, 'exclude', []);

    // lineWidth 0: never fold long scalars (paths) across lines.
    // The serializer always emits "\n"; restore CRLF when the template uses it so the
    // generated config matches the template's line endings on every OS.
    const header = headerLines.length > 0 ? `${headerLines.join('\n')}\n\n` : '';
    const text = header + doc.toString({ lineWidth: 0 });
    const eol = templateText.includes('\r\n') ? '\r\n' : '\n';
    return { ok: true, value: eol === '\n' ? text : text.replace(/\r?\n/g, eol) };
}
