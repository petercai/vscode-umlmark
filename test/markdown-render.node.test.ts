import * as assert from 'assert';
import { renderHtml, renderUrlsAsHtml, MarkdownTokenLike } from '../src/markdown-it-plantuml/render';

function runMarkdownRenderTests(): void {
    const nonPlantumlTokens: MarkdownTokenLike[] = [
        {
            type: 'fence',
            content: '```ts\nconst a = 1;\n```',
            tag: 'code',
        },
    ];

    const passthroughHtml = renderHtml(nonPlantumlTokens, 0);
    assert.equal(passthroughHtml, nonPlantumlTokens[0].content, 'non-plantuml token should pass through');

    const objectHtml = renderUrlsAsHtml(
        ['https://example.com/a.svg', 'https://example.com/b.svg'],
        'image/svg+xml',
        true,
    );
    assert.ok(objectHtml.includes('<object type="image/svg+xml" data="https://example.com/a.svg"></object>'));
    assert.ok(objectHtml.includes('<object type="image/svg+xml" data="https://example.com/b.svg"></object>'));

    const previewHtml = renderUrlsAsHtml(
        ['https://example.com/a.png', 'https://example.com/b.png'],
        'image/png',
        false,
    );
    assert.ok(previewHtml.includes('<img style="background-color:#FFF;" src="https://example.com/a.png">'));
    assert.ok(previewHtml.includes('<img style="background-color:#FFF;" src="https://example.com/b.png">'));

    console.log('[test] markdown-render.node.test passed');
}

runMarkdownRenderTests();
