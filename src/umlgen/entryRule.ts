'use strict';

/**
 * Cursor-aware sequence entry (Q18-B / Q30 / Q31). Pure: no `vscode` import.
 *
 * The command layer turns the editor's document symbols into a chain of frames that
 * enclose the cursor (outermost first); this module maps that chain to an include rule
 * in the grammar each UMLGen generator understands (fact F12):
 *
 * | Cursor                         | Python / TS             | Java                    |
 * |--------------------------------|-------------------------|-------------------------|
 * | inside a method                | file.py:Class.method    | path/File.java:method   |
 * | inside a module-level function | file.py:func            | —                       |
 * | in a class, outside methods    | file.py:Class.*         | whole file              |
 * | elsewhere                      | whole file              | whole file              |
 */

import { EntryRule, SourceLanguage, toIncludeRule } from './configSpec';

export type FrameKind = 'class' | 'method' | 'function';

/** One symbol enclosing the cursor */
export interface SymbolFrame {
    readonly kind: FrameKind;
    readonly name: string;
}

/**
 * Build the entry rule for the anchor file, or undefined when the whole file should be used.
 *
 * The OUTERMOST callable wins: a nested helper function cannot be addressed by the CLI,
 * so the cursor inside it maps to the method or function that contains it.
 */
export function entryRuleFor(language: SourceLanguage, anchorRel: string, chain: readonly SymbolFrame[]): EntryRule | undefined {
    const left = toIncludeRule(anchorRel);
    const callableIndex = chain.findIndex(f => f.kind !== 'class');
    const enclosingClasses = (callableIndex < 0 ? chain : chain.slice(0, callableIndex)).filter(f => f.kind === 'class');
    const owner = enclosingClasses[enclosingClasses.length - 1];

    if (callableIndex >= 0) {
        const callable = chain[callableIndex].name;
        if (language === 'java') {
            // umls-gen compares the right side with the bare method name only (F12)
            return owner ? { rule: `${left}:${callable}`, nameSuffix: callable } : undefined;
        }
        return owner
            ? { rule: `${left}:${owner.name}.${callable}`, nameSuffix: callable }
            : { rule: `${left}:${callable}`, nameSuffix: callable };
    }

    // In a class body but not inside a method: all public methods of that class (Python/TS only)
    if (owner && language !== 'java') {
        return { rule: `${left}:${owner.name}.*`, nameSuffix: owner.name };
    }
    return undefined;
}
