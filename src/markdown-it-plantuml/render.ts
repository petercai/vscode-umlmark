export interface MarkdownTokenLike {
    type: string;
    content: string;
    tag?: string;
}

export function renderUrlsAsHtml(urls: string[], mimeType: string, renderAsObject: boolean): string {
    return urls.reduce((html, url) => {
        return html + (renderAsObject
            ? `\n<object type="${mimeType}" data="${url}"></object>`
            : `\n<img style="background-color:#FFF;" src="${url}">`);
    }, "");
}

export function renderHtml(tokens: MarkdownTokenLike[], idx: number) {
    // console.log("request html for:", idx, tokens[idx].content);
    let token = tokens[idx];
    if (token.type !== "plantuml") return tokens[idx].content;
    const { Diagram } = require('../umlmark/diagram/diagram');
    const { DiagramType } = require('../umlmark/diagram/type');
    const { MakeDiagramURL } = require('../umlmark/urlMaker/urlMaker');
    const { config } = require('../umlmark/config');
    const { localize } = require('../umlmark/common');
    let diagram = new Diagram(token.content);
    // Ditaa only supports png
    let format = diagram.type == DiagramType.Ditaa ? "png" : "svg";
    let mimeType = diagram.type == DiagramType.Ditaa ? "image/png" : "image/svg+xml";
    let result = MakeDiagramURL(diagram, format);
    let renderAsObject = token.tag == "object" && format == "svg";
    return config.server(diagram.parentUri) ?
        renderUrlsAsHtml(result.urls, mimeType, renderAsObject) :
        `\n<pre><code><code>⚠️${localize(53, null)}\n\n${diagram.content}</code></code></pre>`;
}