import * as assert from 'assert';
import { renderHtml, renderUrlsAsHtml, MarkdownTokenLike } from '../src/markdown-it-plantuml/render';

suite('Markdown Render Tests', () => {
    test('renderHtml returns original content for non-plantuml tokens', () => {
        const tokens: MarkdownTokenLike[] = [
            {
                type: 'fence',
                content: '```ts\nconst a = 1;\n```',
                tag: 'code',
            },
        ];

        const html = renderHtml(tokens, 0);

        assert.equal(html, tokens[0].content);
    });

    test('renderUrlsAsHtml outputs object nodes for svg object mode', () => {
        const html = renderUrlsAsHtml(
            ['https://example.com/a.svg', 'https://example.com/b.svg'],
            'image/svg+xml',
            true,
        );

        assert.ok(html.includes('<object type="image/svg+xml" data="https://example.com/a.svg"></object>'));
        assert.ok(html.includes('<object type="image/svg+xml" data="https://example.com/b.svg"></object>'));
    });

    test('renderUrlsAsHtml outputs img nodes for preview mode', () => {
        const html = renderUrlsAsHtml(
            ['https://example.com/a.png', 'https://example.com/b.png'],
            'image/png',
            false,
        );

        assert.ok(html.includes('<img style="background-color:#FFF;" src="https://example.com/a.png">'));
        assert.ok(html.includes('<img style="background-color:#FFF;" src="https://example.com/b.png">'));
    });
});
