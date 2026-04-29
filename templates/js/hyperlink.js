function addHyperlinkManager(vscode) {
    let imgContainer= document.getElementById('image-container');
    imgContainer.addEventListener('click', e => {
        if (e.button == 0 && e.target.target == "_blank") {
            let href = e.target.href;
            
            console.log('[PlantUML] Link clicked:', href);
            
            // Check if this is an external link (http, https, ftp)
            let isExternalLink = href.match(/^https?:\/\//i) || href.match(/^ftp:\/\//i);
            
            console.log('[PlantUML] Is external link:', isExternalLink);
            
            if (!isExternalLink) {
                // Extract workspace-relative file path from various URL formats
                // Format examples:
                // - vscode-webview://xxx/files/models/media.py:388
                // - file:///path/to/files/models/media.py
                // - files/models/media.py:388
                
                let filePath = null;
                let lineNumber = null;
                
                // Strip vscode-webview:// protocol and UUID
                // Pattern: vscode-webview://[uuid]/path/to/file.py:line
                let webviewMatch = href.match(/vscode-webview:\/\/[^\/]+\/(.+?)(?::(\d+))?$/);
                if (webviewMatch) {
                    filePath = webviewMatch[1];
                    lineNumber = webviewMatch[2] ? parseInt(webviewMatch[2]) : null;
                    console.log('[PlantUML] Extracted from vscode-webview URL:', {filePath, lineNumber});
                } else {
                    // Try file:// protocol
                    let cleanHref = href.replace(/^file:\/\//, '');
                    
                    // Extract path with optional line number
                    let pathMatch = cleanHref.match(/([^\/]+\/.+?)(?::(\d+))?$/);
                    
                    if (!pathMatch) {
                        // Maybe it's just a simple relative path
                        pathMatch = cleanHref.match(/^([^:]+?)(?::(\d+))?$/);
                    }
                    
                    if (pathMatch) {
                        filePath = pathMatch[1];
                        lineNumber = pathMatch[2] ? parseInt(pathMatch[2]) : null;
                        console.log('[PlantUML] Extracted from file path:', {filePath, lineNumber});
                    }
                }
                
                if (filePath) {
                    console.log('[PlantUML] Sending openFileLink:', {filePath, lineNumber});
                    
                    // Send message to extension
                    vscode.postMessage({
                        "action": "openFileLink",
                        "filePath": filePath,
                        "lineNumber": lineNumber
                    });
                    e.stopImmediatePropagation();
                    e.preventDefault();
                    return;
                }
            }
            
            // Handle external links (http://, https://, ftp://)
            console.log('[PlantUML] Sending openExternalLink:', href);
            vscode.postMessage({
                "action": "openExternalLink",
                "href": href
            });

            e.stopImmediatePropagation();
        }
    });

    imgContainer.addEventListener('mousedown', e => {
        if (e.button == 0 && e.target.target == "_blank") {
            // prevent zoom selection when clicking on links
            e.stopImmediatePropagation();
        }
    });

    imgContainer.addEventListener('mouseup', e => {
        if (e.button == 0 && e.target.target == "_blank") {
            // prevent zoom action when clicking on links
            e.stopImmediatePropagation();
        }
    });
}