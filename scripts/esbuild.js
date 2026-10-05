// Bundles the extension into a single file (dist/extension.js) for packaging.
// Usage: node ./scripts/esbuild.js [--production] [--watch]
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Emits the begin/end markers matched by the "watch:esbuild" problem matcher in .vscode/tasks.json.
const watchMarkerPlugin = {
    name: 'watch-markers',
    setup(build) {
        build.onStart(() => console.log('[watch] build started'));
        build.onEnd(result => {
            for (const { text, location } of result.errors) {
                console.error(`✘ [ERROR] ${text}`);
                if (location) {
                    console.error(`    ${location.file}:${location.line}:${location.column}:`);
                }
            }
            console.log('[watch] build finished');
        });
    },
};

async function main() {
    const ctx = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node16',
        outfile: 'dist/extension.js',
        external: ['vscode'],
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        logLevel: watch ? 'silent' : 'warning',
        plugins: watch ? [watchMarkerPlugin] : [],
    });
    if (watch) {
        await ctx.watch();
        return;
    }
    const result = await ctx.rebuild();
    await ctx.dispose();
    if (result.errors.length > 0) {
        process.exit(1);
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
