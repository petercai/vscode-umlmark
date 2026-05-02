import * as vscode from 'vscode';
import * as nls from "vscode-nls";
import { contextManager } from './context';

export const languageid = "plantuml";

export var outputPanel = vscode.window.createOutputChannel("UMLMark");
export var bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);

// Configure nls
nls.config(<nls.Options>{ locale: vscode.env.language });

// Localize gets initialized lazily - declare early so listener can access it
let _localize: any;

// Get extensionPath safely
function getExtPath(): string {
    // First try context manager (set during activation)
    if (contextManager.context) {
        return contextManager.context.extensionPath;
    }
    // Fallback: try to get extension by ID
    const ext = vscode.extensions.getExtension("petercai.umlmark");
    if (ext?.extensionPath) {
        return ext.extensionPath;
    }
    throw new Error("Extension context not available");
}

// Initialize extensionPath - will be properly set during activation
export let extensionPath: string;
try {
    extensionPath = getExtPath();
} catch (e) {
    // Extension not ready yet, will be set by listener
    extensionPath = "";
}

// Update extensionPath when context is available
contextManager.addInitiatedListener((ctx: vscode.ExtensionContext) => {
    extensionPath = ctx.extensionPath;
    // Force re-initialization of localize with correct path
    _localize = undefined;
});

function initLocalize() {
    if (!_localize && extensionPath) {
        try {
            // loadMessageBundle expects path without extension, it will add .nls.json based on locale
            const bundleBasePath = `${extensionPath.replace(/\\/g, "/")}/langs/lang`;
            _localize = nls.loadMessageBundle(bundleBasePath);
        } catch (err) {
            outputPanel.appendLine(`[umlmark] failed to load message bundle: ${String(err)}`);
            // Return a dummy localize function
            _localize = () => '';
        }
    }
    return _localize;
}

// Export localize as function that initializes on first use
export var localize: any = function(...args: any[]) {
    const loc = initLocalize();
    return loc ? loc(...args) : '';
};
