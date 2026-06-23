import * as vscode from 'vscode';
declare function require(name: string): any;
declare const Buffer: any;
declare const console: { log: (...args: any[]) => void; error: (...args: any[]) => void; };
declare function setTimeout(handler: (...args: any[]) => void, timeout?: number): any;

const fs = require('fs');
const path = require('path');

import { RenderTask, RenderError } from '../umlmark/renders/interfaces'
import { Diagram } from '../umlmark/diagram/diagram';
import { diagramsOf, currentDiagram } from '../umlmark/diagram/tools';
import { config } from '../umlmark/config';
import { localize, extensionPath, outputPanel } from '../umlmark/common';
import { parseError, calculateExportPath, addFileIndex, showMessagePanel, fileToBase64 } from '../umlmark/tools';
import { exportToBuffer } from "../umlmark/exporter/exportToBuffer";
import { UI } from '../ui/ui';

/**
 * Build an HTML image map from <a> elements in a PlantUML SVG.
 *
 * Why SVG-derived instead of -pipemap:
 *   -pipemap generates coordinates in PNG space, which mismatches SVG natural dimensions
 *   causing clicks to land on wrong links. Worse, it merges ALL occurrences of the same
 *   href into one giant rect spanning the full diagram height (e.g. coords y2=6336 for a
 *   6904px tall SVG), so many links overlap and the wrong one always wins.
 *
 * PlantUML SVG uses two patterns inside <a>:
 *   1. <a><rect fill="#..." .../></a>  — participant boxes; use rect's x/y/width/height.
 *   2. <a><text x y textLength font-size>LABEL</text></a> — inline message label links;
 *      derive bounding box from text position (y is the baseline in SVG coordinates).
 */
function buildImageMapFromSvg(svgContent: string): string {
    const areas: string[] = [];
    const aTagRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
    let aMatch: RegExpExecArray | null;
    while ((aMatch = aTagRegex.exec(svgContent)) !== null) {
        const attrString = aMatch[1];
        const inner = aMatch[2];

        // href= (SVG 2) or xlink:href= (SVG 1.1) — PlantUML emits both for compatibility
        const hrefMatch = attrString.match(/(?:xlink:href|href)="([^"]*)"/);
        if (!hrefMatch || !hrefMatch[1]) continue;
        const href = hrefMatch[1];

        // Default title from the <a> attribute (may be the full URL for 2-arg links)
        let title = '';
        const titleAttrMatch = attrString.match(/(?:xlink:title|title)="([^"]*)"/);
        if (titleAttrMatch) title = titleAttrMatch[1];

        let x1 = NaN, y1 = NaN, x2 = NaN, y2 = NaN;

        // Pattern 1: participant boxes — <a><rect x y width height .../></a>
        const rectTagMatch = inner.match(/<rect\b([^>]*)>/);
        if (rectTagMatch) {
            const ra = rectTagMatch[1];
            const xm = ra.match(/\bx="([^"]*)"/);
            const ym = ra.match(/\by="([^"]*)"/);
            const wm = ra.match(/\bwidth="([^"]*)"/);
            const hm = ra.match(/\bheight="([^"]*)"/);
            if (xm && ym && wm && hm) {
                const x = parseFloat(xm[1]);
                const y = parseFloat(ym[1]);
                const w = parseFloat(wm[1]);
                const h = parseFloat(hm[1]);
                if (!isNaN(x) && !isNaN(y) && !isNaN(w) && !isNaN(h)) {
                    x1 = x; y1 = y; x2 = x + w; y2 = y + h;
                }
            }
        }

        // Pattern 2: inline text links — <a><text x y textLength font-size>LABEL</text></a>
        // SVG <text> y is the BASELINE; compute bounding box above and below the baseline.
        if (isNaN(x1)) {
            const textTagMatch = inner.match(/<text\b([^>]*)>/);
            if (textTagMatch) {
                const ta = textTagMatch[1];
                const xm = ta.match(/\bx="([^"]*)"/);
                const ym = ta.match(/\by="([^"]*)"/);
                const tlm = ta.match(/\btextLength="([^"]*)"/);
                const fsm = ta.match(/\bfont-size="([^"]*)"/);
                if (xm && ym) {
                    const x = parseFloat(xm[1]);
                    const y = parseFloat(ym[1]);          // baseline
                    const textLen = tlm ? parseFloat(tlm[1]) : 80;
                    const fontSize = fsm ? parseFloat(fsm[1]) : 12;
                    if (!isNaN(x) && !isNaN(y)) {
                        x1 = x;
                        y1 = y - fontSize;                // cap height above baseline
                        x2 = x + textLen;
                        y2 = y + Math.ceil(fontSize * 0.3); // descender below baseline
                        // Prefer the displayed label (text content) over full URL as tooltip
                        const tc = inner.match(/<text\b[^>]*>([^<]*)<\/text>/);
                        if (tc && tc[1].trim()) title = tc[1].trim();
                    }
                }
            }
        }

        if (isNaN(x1)) continue;

        const titleAttr = title ? ` title="${title}"` : '';
        areas.push(
            `<area shape="rect" coords="${Math.round(x1)},${Math.round(y1)},${Math.round(x2)},${Math.round(y2)}" href="${href}"${titleAttr}>`
        );
    }
    return areas.length > 0 ? `<map>\n${areas.join('\n')}\n</map>` : '<map></map>';
}

enum previewStatus {
    default,
    error,
    processing,
}
class Previewer extends vscode.Disposable {

    private _uiPreview!: UI;
    private _disposables: vscode.Disposable[] = [];
    private watchDisposables: vscode.Disposable[] = [];
    private status: previewStatus = previewStatus.default;
    private previewPageStatus: string = "";
    private rendered: Diagram | null = null;
    private task: RenderTask | null = null;
    private taskKilling: boolean = false;
    private renderedFileWatcher: vscode.FileSystemWatcher | undefined;

    private images: string[] = [];
    private imageError: string = "";
    private error: string = "";
    private errorDetail: string = "";
    private zoomUpperLimit: boolean = false;

    constructor() {
        super(() => this.dispose());
        this.register();
    }

    dispose() {
        this._disposables && this._disposables.length && this._disposables.map(d => d.dispose());
        this.watchDisposables && this.watchDisposables.length && this.watchDisposables.map(d => d.dispose());
        if (this.renderedFileWatcher) {
            this.renderedFileWatcher.dispose();
            this.renderedFileWatcher = undefined;
        }
    }

    reset() {
        this.rendered = null;
        this.previewPageStatus = "";
        this.images = [];
        this.imageError = "";
        this.error = "";
        this.errorDetail = "";
    }

    updateWebView(): string | undefined {
        let env = {
            localize: localize,
            images: this.images.reduce((p, c) => {
                if (c.startsWith('data:image/')) {
                    return `${p}<img src="${c}">`
                } else {
                    return `${p}${c.replaceAll('<area ', '<area target="_blank"')}`
                }
            }, ""),
            imageError: "",
            error: "",
            errorDetail: "",
            status: this.previewPageStatus,
            // nonce: Math.random().toString(36).substr(2),
            icon: "file:///" + path.join(extensionPath, "images", "icon-trans.png"),
            settings: JSON.stringify({
                zoomUpperLimit: this.zoomUpperLimit,
                showSpinner: this.status === previewStatus.processing,
                showSnapIndicators: config.previewSnapIndicators,
                swapMouseButtons: config.previewSwapMouseButtons,
            }),
            associatedDiagramPath: this.rendered?.path || "",
            associatedDiagramStartLine: this.rendered?.start ? this.rendered.start.line + 1 : 0,
            associatedDiagramEndLine: this.rendered?.end ? this.rendered.end.line + 1 : 0,
            associatedDiagramIndex: this.rendered?.index ?? 0,
        };
        try {
            switch (this.status) {
                case previewStatus.default:
                case previewStatus.error:
                    env.imageError = this.imageError;
                    // Show only the first line as summary — the raw PlantUML output is
                    // already shown in full inside #error-detail to avoid duplication.
                    const summaryLine = (this.error || "").split('\n')[0] || this.error;
                    env.error = summaryLine;
                    // HTML-escape errorDetail for safe insertion into <pre>
                    env.errorDetail = this.errorDetail
                        .replace(/&/g, "&amp;")
                        .replace(/</g, "&lt;")
                        .replace(/>/g, "&gt;");
                    this._uiPreview.show("preview.html", env);
                    break;
                case previewStatus.processing:
                    if (!this.rendered) {
                        break;
                    }
                    const rendered = this.rendered;
                    env.error = "";
                    env.images = ["svg", "png"].reduce((p, c) => {
                        if (p) return p;
                        let exported = calculateExportPath(rendered, c);
                        exported = addFileIndex(exported, 0, rendered.pageCount);
                        return fs.existsSync(exported) ? env.images = `<img src="${fileToBase64(exported)}">` : "";
                    }, "");
                    this._uiPreview.show("preview.html", env);
                    break;
                default:
                    break;
            }
        } catch (error) {
            return String(error)
        }
    }
    setUIStatus(status: string) {
        this.previewPageStatus = status;
    }
    async update(processingTip: boolean) {
        if (this.taskKilling) return;
        await this.killTasks();
        // console.log("updating...");
        // do not await doUpdate, so that preview window could open before update task finish.
        this.doUpdate(processingTip).catch(e => showMessagePanel(e));
    }
    private async updateByDiagram(diagram: Diagram, processingTip: boolean) {
        this.rendered = diagram;
        this.setupRenderedFileWatcher();

        let task: RenderTask = exportToBuffer(diagram, "svg");
        this.task = task;

        if (processingTip) this.processing();
        await task.promise.then(
            result => {
                if (task.canceled) return;
                this.task = null;
                this.status = previewStatus.default;

                this.error = "";
                this.imageError = "";
                // Build image list: for each SVG/PNG buffer immediately append its image map.
                // SVG buffers get a map extracted from their own <a> elements (correct coord space).
                // PNG buffers get an empty map (preview only uses SVG; PNG is a fallback thumbnail).
                // -pipemap is no longer called (removed from exportDiagram preview path) because
                // its coordinates are in PNG space and mismatch SVG natural dimensions.
                this.images = result.reduce((p, buf) => {
                    const sigPNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
                    const isPNG = buf.slice(0, sigPNG.length).equals(sigPNG);
                    const isSVG = (buf.slice(0, 256).indexOf('<svg') >= 0);

                    if (isPNG || isSVG) {
                        const b64 = buf.toString('base64');
                        if (!b64) return p;
                        p.push(`data:image/${isPNG ? 'png' : "svg+xml"};base64,${b64}`);
                        // Append image map immediately after its image so switcher.js
                        // can pair them by index (both are collected by tag name, not position)
                        p.push(isSVG ? buildImageMapFromSvg(buf.toString()) : '<map></map>');
                    }
                    return p;
                }, <string[]>[]);
                this.updateWebView();
            },
            error => {
                if (task.canceled) return;
                this.task = null;
                this.status = previewStatus.error;
                let err = parseError(error)[0];
                this.error = err.error;
                this.errorDetail = this.buildErrorDetail(err, diagram);
                let b64 = err.out.toString('base64');
                if (!(b64 || err.error)) return;
                this.imageError = `data:image/svg+xml;base64,${b64}`
                this.updateWebView();
            }
        );
    }
    /**
     * Build a structured, copyable error detail string for display in the error panel.
     * Handles two error origins:
     *   1. PlantUML local render (rawError set): parses SEVERITY/LINE/MESSAGE format;
     *      detects embedded Java stack traces from PlantUML internal errors.
     *   2. Extension / network errors (rawError absent): detects JS stack traces and
     *      labels the section header accordingly.
     */
    private buildErrorDetail(err: RenderError, diagram: Diagram): string {
        const filePath = err.filePath || diagram.path || "(unsaved file)";
        const diagramName = diagram.name || "(unnamed)";
        const rawPlantumlError = err.rawError ?? "";   // PlantUML stderr (local render only)
        const fullError = err.error ?? "";             // localized/full error string

        const lines: string[] = [];
        lines.push(`File:    ${filePath}`);
        lines.push(`Diagram: ${diagramName}`);

        if (rawPlantumlError) {
            // --- PlantUML local render error ---
            // Stderr format: SEVERITY\nLINE_NUM(0-based)\nMESSAGE[\nJava stack trace...]
            const rawLines = rawPlantumlError.split(/\r?\n/);
            const nonEmptyLines = rawLines.filter(l => l.trim());

            if (
                nonEmptyLines.length >= 3 &&
                /^[A-Z_]+$/.test(nonEmptyLines[0]) &&
                /^\d+$/.test(nonEmptyLines[1])
            ) {
                const lineNumZero = parseInt(nonEmptyLines[1], 10);
                lines.push(`Line:    ${lineNumZero + 1}  (PlantUML reports line ${lineNumZero})`);
                lines.push(`Type:    ${nonEmptyLines[0]}`);
                // Remaining lines after severity+linenum form the human-readable message
                const msgPart = nonEmptyLines.slice(2).join(" ");
                if (msgPart) lines.push(`Message: ${msgPart}`);
            }

            // Detect embedded Java stack trace (PlantUML internal / unexpected errors)
            const hasJavaStack = /^\s+at \S+\.\S+\(/m.test(rawPlantumlError);

            lines.push("");
            lines.push("=== PlantUML Error Output ===");
            lines.push(rawPlantumlError);

            if (hasJavaStack) {
                lines.push("");
                lines.push("(Java stack trace detected — copy all details above and attach when reporting)");
            }
        } else {
            // --- Extension / network error (no PlantUML stderr available) ---
            // err.error may be a JS TypeError stack trace or an HTTP error message.
            const hasJsStack = /\n\s+at /.test(fullError);
            lines.push("");
            lines.push(hasJsStack
                ? "=== Extension Error (Stack Trace) ==="
                : "=== Error Details ==="
            );
            lines.push(fullError);
        }

        return lines.join("\n");
    }
    private killTasks() {
        if (!this.task) return;
        this.task.canceled = true;

        if (!this.task.processes || !this.task.processes.length)
            return Promise.resolve(true);
        this.taskKilling = true;
        return Promise.all(
            this.task.processes.map(p => this.killTask(p))
        ).then(() => {
            this.task = null;
            this.taskKilling = false;
        });
    }
    private killTask(process: any) {
        return new Promise((resolve, reject) => {
            process.on('exit', (code: any, sig: any) => {
                // console.log(`Killed ${process.pid} with code ${code} and signal ${sig}!`);
                resolve(true);
            });
            
            if(!process.kill('SIGINT') && process.exitCode != null){
                // console.log(`Process ${process.pid} exited with status code ${process.exitCode}`);
                resolve(true);
            }
        })
    }
    get TargetChanged(): boolean {
        let current = currentDiagram();
        if (!current) return false;
        let changed = (!this.rendered || !this.rendered.isEqual(current));
        if (changed) {
            this.rendered = current;
            this.setupRenderedFileWatcher();
            this.error = "";
            this.images = [];
            this.imageError = "";
            this.previewPageStatus = "";
        }
        return changed;
    }
    private async resolveAssociatedDiagram(): Promise<Diagram | undefined> {
        if (!this.rendered?.path) return undefined;
        let document = await vscode.workspace.openTextDocument(this.rendered.path);
        let diagrams = diagramsOf(document);
        if (!diagrams.length) return undefined;

        let index = this.rendered.index;
        if (index >= 0 && index < diagrams.length) {
            return diagrams[index];
        }
        return diagrams[0];
    }
    private async activateAssociatedPumlEditor() {
        let diagram = await this.resolveAssociatedDiagram();
        if (!diagram) {
            vscode.window.showWarningMessage(localize(3, null));
            return;
        }
        let editor = await vscode.window.showTextDocument(diagram.document, {
            preview: false,
            viewColumn: vscode.ViewColumn.One,
            preserveFocus: false,
        });
        // Place cursor at the start of the associated diagram, without range selection.
        // This prevents the "select all" behavior and lets user start editing/reading immediately.
        let cursor = new vscode.Selection(diagram.start, diagram.start);
        editor.selection = cursor;
        editor.revealRange(
            new vscode.Range(diagram.start, diagram.end),
            vscode.TextEditorRevealType.InCenter,
        );
        outputPanel.appendLine(`[INFO] Activated associated UMLMark editor: ${diagram.path}:${diagram.start.line + 1}-${diagram.end.line + 1}`);
    }
    private async refreshAssociatedPreview(processingTip: boolean, silent: boolean = false) {
        let diagram = await this.resolveAssociatedDiagram();
        if (!diagram) {
            if (!silent) {
                vscode.window.showWarningMessage(localize(3, null));
            }
            return;
        }
        if (!silent) {
            outputPanel.appendLine(`[INFO] Force refresh preview from associated UMLMark source: ${diagram.path}`);
        }
        await this.killTasks();
        await this.updateByDiagram(diagram, processingTip);
    }
    private setupRenderedFileWatcher() {
        if (this.renderedFileWatcher) {
            this.renderedFileWatcher.dispose();
            this.renderedFileWatcher = undefined;
        }
        if (!this.rendered?.path) return;

        let baseUri = vscode.Uri.file(path.dirname(this.rendered.path));
        let pattern = path.basename(this.rendered.path);
        this.renderedFileWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(baseUri, pattern),
            false,
            false,
            true,
        );
        this.renderedFileWatcher.onDidChange(() => {
            if (!config.previewAutoUpdate) return;
            this.refreshAssociatedPreview(false, true).catch(e => showMessagePanel(e));
        });
        this.renderedFileWatcher.onDidCreate(() => {
            if (!config.previewAutoUpdate) return;
            this.refreshAssociatedPreview(false, true).catch(e => showMessagePanel(e));
        });
    }
    private async doUpdate(processingTip: boolean) {
        let diagram = currentDiagram();
        if (!diagram) {
            this.status = previewStatus.error;
            this.error = localize(3, null);
            this.images = [];
            this.updateWebView();
            return;
        }
        await this.updateByDiagram(diagram, processingTip);
    }
    //display processing tip
    processing() {
        this.status = previewStatus.processing;
        this.updateWebView();
    }
    register() {
        let disposable: vscode.Disposable;

        //register command
        disposable = vscode.commands.registerCommand('umlmark.preview', async () => {
            try {
                var editor = vscode.window.activeTextEditor;
                if (!editor) return;
                let diagrams = diagramsOf(editor.document);
                if (!diagrams.length) return;

                //reset in case that starting commnad in none-diagram area, 
                //or it may show last error image and may cause wrong "TargetChanged" result on cursor move.
                this.reset();
                this.TargetChanged;
                //update preview
                await this.update(true);
            } catch (error) {
                showMessagePanel(error);
            }
        });
        this._disposables.push(disposable);

        this._uiPreview = new UI(
            "umlmark.preview",
            localize(17, null),
            path.join(extensionPath, "templates"),
        );
        this._disposables.push(this._uiPreview);

        this._uiPreview.addEventListener("message", e => {
            console.log('[UMLMark] Received message:', e.message);
            if (e.message.action == "openExternalLink") {
                vscode.env.openExternal(e.message.href);
            } else if (e.message.action == "openFileLink") {
                // Handle local file links (e.g., [[files/views/media.py:269]])
                console.log('[UMLMark] Opening file:', e.message.filePath, 'line:', e.message.lineNumber);
                this.openFileInEditor(e.message.filePath, e.message.lineNumber);
            } else if (e.message.action == "activateAssociatedPumlEditor") {
                this.activateAssociatedPumlEditor().catch(error => showMessagePanel(error));
            } else if (e.message.action == "refreshAssociatedPreview") {
                this.refreshAssociatedPreview(true).catch(error => showMessagePanel(error));
            } else {
                this.setUIStatus(JSON.stringify(e.message));
            }
        });
        this._uiPreview.addEventListener("open", () => this.startWatch());
        this._uiPreview.addEventListener("close", () => { this.stopWatch(); this.killTasks(); });
    }
    
    private async openFileInEditor(filePath: string, lineNumber: number | null) {
        console.log('[UMLMark] openFileInEditor called with:', {filePath, lineNumber});
        try {
            // Clean up the file path - remove any vscode-webview:// protocol if present
            let cleanPath = filePath;
            
            // Strip vscode-webview://xxx/ prefix if present (shouldn't happen, but safety check)
            let webviewMatch = cleanPath.match(/^vscode-webview:\/\/[^\/]+\/(.+)$/);
            if (webviewMatch) {
                cleanPath = webviewMatch[1];
                console.log('[UMLMark] Stripped vscode-webview protocol, clean path:', cleanPath);
            }
            
            // Strip file:// protocol if present
            cleanPath = cleanPath.replace(/^file:\/\//, '');
            
            // Strip any leading slashes that would make it absolute
            cleanPath = cleanPath.replace(/^\/+/, '');
            
            console.log('[UMLMark] Clean path:', cleanPath);
            
            // Resolve workspace-relative path to absolute path
            let workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            console.log('[UMLMark] Workspace folder:', workspaceFolder?.uri.fsPath);
            
            if (!workspaceFolder) {
                vscode.window.showWarningMessage(`No workspace folder found to resolve: ${cleanPath}`);
                return;
            }
            
            let absolutePath = path.join(workspaceFolder.uri.fsPath, cleanPath);
            console.log('[UMLMark] Absolute path:', absolutePath);
            
            // Check if file exists
            if (!fs.existsSync(absolutePath)) {
                console.log('[UMLMark] File not found:', absolutePath);
                vscode.window.showWarningMessage(`File not found: ${cleanPath}`);
                return;
            }
            
            console.log('[UMLMark] Opening document...');
            // Open the document
            let document = await vscode.workspace.openTextDocument(absolutePath);
            let editor = await vscode.window.showTextDocument(document, {
                preview: false,
                viewColumn: vscode.ViewColumn.One
            });
            
            console.log('[UMLMark] Document opened successfully');
            
            // Navigate to line if specified
            if (lineNumber && lineNumber > 0) {
                let position = new vscode.Position(lineNumber - 1, 0); // Convert to 0-based
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(
                    new vscode.Range(position, position),
                    vscode.TextEditorRevealType.InCenter
                );
                console.log('[UMLMark] Navigated to line:', lineNumber);
            }
        } catch (error) {
            console.error('[UMLMark] Error opening file:', error);
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to open file: ${message}`);
        }
    }
    
    startWatch() {
        let disposable: vscode.Disposable;
        let disposables: vscode.Disposable[] = [];

        //register watcher
        let lastTimestamp = new Date().getTime();
        disposable = vscode.workspace.onDidChangeTextDocument(e => {
            if (!config.previewAutoUpdate) return;
            if (!e || !e.document || !e.document.uri) return;
            if (e.document.uri.scheme == "plantuml") return;

            // Keep preview synced with its associated puml source,
            // even after user navigates to non-puml files via hyperlinks.
            if (this.rendered?.path && e.document.uri.fsPath == this.rendered.path) {
                this.refreshAssociatedPreview(false, true).catch(error => showMessagePanel(error));
                return;
            }

            lastTimestamp = new Date().getTime();
            setTimeout(() => {
                if (new Date().getTime() - lastTimestamp >= 400) {
                    if (!currentDiagram()) return;
                    this.update(false);
                }
            }, 500);
        });
        disposables.push(disposable);
        disposable = vscode.window.onDidChangeTextEditorSelection(e => {
            if (!config.previewAutoUpdate) return;
            lastTimestamp = new Date().getTime();
            setTimeout(() => {
                if (new Date().getTime() - lastTimestamp >= 400) {
                    if (!this.TargetChanged) return;
                    this.update(true);
                }
            }, 500);
        });
        disposables.push(disposable);

        this.watchDisposables = disposables;
    }
    stopWatch() {
        for (let d of this.watchDisposables) {
            d.dispose();
        }
        this.watchDisposables = [];
        if (this.renderedFileWatcher) {
            this.renderedFileWatcher.dispose();
            this.renderedFileWatcher = undefined;
        }
    }
}
export const previewer = new Previewer();