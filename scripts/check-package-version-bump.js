#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const baseRef = process.env.UMLMARK_VERSION_CHECK_BASE_REF || 'HEAD~1';
const initialVersion = process.env.UMLMARK_INITIAL_VERSION || '1.0.5';
const packagePath = path.resolve(process.cwd(), 'package.json');

function get(obj, pathArr) {
    return pathArr.reduce((acc, key) => (acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined), obj);
}

function stable(value) {
    return JSON.stringify(value);
}

function compareSemver(a, b) {
    const aParts = String(a).split('.').map((x) => Number(x));
    const bParts = String(b).split('.').map((x) => Number(x));
    const maxLen = Math.max(aParts.length, bParts.length);

    for (let i = 0; i < maxLen; i += 1) {
        const av = Number.isFinite(aParts[i]) ? aParts[i] : 0;
        const bv = Number.isFinite(bParts[i]) ? bParts[i] : 0;
        if (av > bv) return 1;
        if (av < bv) return -1;
    }

    return 0;
}

function readPackageFromGit(ref) {
    try {
        const raw = execSync(`git show ${ref}:package.json`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return JSON.parse(raw);
    } catch (error) {
        console.warn(`[version-check] Skip: cannot read package.json from ${ref}.`);
        return null;
    }
}

function main() {
    const current = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const previous = readPackageFromGit(baseRef);

    if (!previous) {
        process.exit(0);
    }

    const visiblePaths = [
        ['icon'],
        ['displayName'],
        ['description'],
        ['contributes', 'commands'],
        ['contributes', 'menus'],
        ['contributes', 'keybindings'],
    ];

    const changedVisiblePaths = visiblePaths
        .filter((pathArr) => stable(get(previous, pathArr)) !== stable(get(current, pathArr)))
        .map((pathArr) => pathArr.join('.'));

    if (!changedVisiblePaths.length) {
        console.log('[version-check] No visible package.json changes detected.');
        process.exit(0);
    }

    if (previous.version === current.version) {
        console.error('[version-check] Visible package.json changes detected without version bump.');
        console.error(`[version-check] Base ref: ${baseRef}`);
        console.error(`[version-check] Changed paths: ${changedVisiblePaths.join(', ')}`);
        console.error(`[version-check] Current version: ${current.version}`);
        process.exit(1);
    }

    if (current.version === initialVersion && previous.version !== initialVersion) {
        console.log(`[version-check] OK: initial version baseline ${initialVersion} (legacy base ${previous.version} ignored).`);
        console.log(`[version-check] Visible paths changed: ${changedVisiblePaths.join(', ')}`);
        process.exit(0);
    }

    if (compareSemver(current.version, previous.version) < 0) {
        console.error('[version-check] Detected a version downgrade for visible package.json changes.');
        console.error(`[version-check] Base ref: ${baseRef}`);
        console.error(`[version-check] Previous version: ${previous.version}`);
        console.error(`[version-check] Current version: ${current.version}`);
        process.exit(1);
    }

    console.log(`[version-check] OK: version bumped ${previous.version} -> ${current.version}`);
    console.log(`[version-check] Visible paths changed: ${changedVisiblePaths.join(', ')}`);
}

main();
