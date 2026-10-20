/** Pure helpers for @albasov/ts-agent-rig dependency pin comparison. */
export function readPackageDepSpec(pkg, name) {
    if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg))
        return null;
    const record = pkg;
    for (const key of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
    ]) {
        const block = record[key];
        if (block === null || typeof block !== 'object' || Array.isArray(block)) {
            continue;
        }
        const v = block[name];
        if (typeof v === 'string')
            return v;
    }
    return null;
}
export function extractPnpmLockPackageBlock(lockRaw, name) {
    const text = typeof lockRaw === 'string' ? lockRaw : '';
    if (!text)
        return '';
    const lines = text.split('\n');
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined || !line.includes(name))
            continue;
        hits.push(line.trim());
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
            const next = lines[j];
            if (next === undefined || !/^\s+/.test(next))
                break;
            hits.push(next.trim());
        }
    }
    return hits.join('\n');
}
//# sourceMappingURL=compare-pin.js.map