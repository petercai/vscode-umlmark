import * as vscode from 'vscode';
import { showMessagePanel, parseError } from '../umlmark/tools';
import { formatRules } from '../umlmark/formatRules';
import * as fmt from '../umlmark/formatter/formatter';
import { languageid } from '../umlmark/common';

export class Formatter extends vscode.Disposable implements vscode.DocumentFormattingEditProvider {
    private _formatter: fmt.Formatter;
    private _disposables: vscode.Disposable[] = [];
    constructor() {
        super(() => this.dispose());
        this._formatter = new fmt.Formatter(
            formatRules,
            {
                allowInlineFormat: false,
                allowSplitLine: true,
                newLineForBlockStart: false
            }
        );
        this._disposables.push(
            vscode.languages.registerDocumentFormattingEditProvider(
                [
                    { scheme: 'file', language: languageid },
                    { scheme: 'untitled', language: languageid },
                ],
                this
            )
        );
    }

    dispose() {
        this._disposables && this._disposables.length && this._disposables.map(d => d.dispose());
    }
    public provideDocumentFormattingEdits(document: vscode.TextDocument, options: vscode.FormattingOptions, token: vscode.CancellationToken): vscode.ProviderResult<vscode.TextEdit[]> {
        try {
            if (vscode.workspace.getConfiguration("editor", document.uri).get("formatOnSave")) {
                console.log("UMLMark format disabled when 'editor.formatOnSave' is on, because it is not reliable enough.");
                return;
            }
            return this._formatter.formate(document, options, token);
        } catch (error) {
            showMessagePanel(parseError(error));
        }
    }
}