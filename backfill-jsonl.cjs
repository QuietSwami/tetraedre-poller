#!/usr/bin/env node
// Convert ONE saved TDS get_values response (format 1 or non-empty format 0) into FlintCORE historical
// message import records. This does not call TDS or FlintCORE and needs no secrets.
const { readFileSync } = require('node:fs');

function convert(body, options) {
    const { deviceUuid, meteringCode, media, unit, t0, t1 } = options;
    if (typeof deviceUuid !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(deviceUuid)) throw new Error('Invalid device UUID');
    if (typeof meteringCode !== 'string' || !/^[A-Za-z0-9_-]{2,100}$/.test(meteringCode)) throw new Error('Use a valid TDS metering code');
    if (![3, 6, 7, 16].includes(Number(media)) || !/^(3|6|7|16)$/.test(String(media))) throw new Error('Invalid media');
    if (typeof unit !== 'string' || !unit.trim() || unit.length > 30) throw new Error('Provide the verified unit');
    if (!Number.isSafeInteger(t0) || !Number.isSafeInteger(t1) || t0 < 0 || t0 > t1) throw new Error('Provide an inclusive Unix-seconds t0/t1 window');
    let rows;
    if (Array.isArray(body)) {
        if (!body.length) throw new Error('Empty format-0 response cannot distinguish no data from denied access');
        rows = body;
    } else if (body && body.access_granted == 1 && Array.isArray(body.Values ?? body.values)) {
        rows = body.Values ?? body.values;
    } else throw new Error('Expected authorized TDS get_values response');
    if (rows.length > 1000) throw new Error('More than 1000 values; split the source window');
    let previous = t0 - 1;
    return rows.map(row => {
        const t = Number(row?.timestamp), v = Number(row?.value), timestamp = t * 1000000;
        if (!Number.isSafeInteger(t) || t < t0 || t > t1 || t < previous ||
            !['string', 'number'].includes(typeof row.value) ||
            (typeof row.value === 'string' && !row.value.trim()) || !Number.isFinite(v) ||
            !Number.isSafeInteger(timestamp)) throw new Error('Malformed, unsorted, or out-of-window TDS reading');
        previous = t;
        return JSON.stringify({
            deviceUuid, timestamp, data_type: 'object',
            data: JSON.stringify({
                source: 'tetraedre', meteringCode, media: Number(media),
                timestamp: t * 1000, sourceTimestampUs: timestamp, value: v, unit,
            }),
        });
    });
}

if (require.main === module) {
    try {
        const args = process.argv.slice(2), flags = {};
        const allowed = ['--device-uuid', '--metering-code', '--media', '--unit', '--t0', '--t1'];
        while (args.length > 1 && args[0].startsWith('--')) {
            const key = args.shift(), value = args.shift();
            if (!allowed.includes(key) || !value || flags[key] !== undefined) throw new Error('Invalid or duplicate argument');
            flags[key] = value;
        }
        if (args.length !== 1 || Object.keys(flags).length !== allowed.length) throw new Error('Usage: node backfill-jsonl.cjs --device-uuid UUID --metering-code CODE --media 7 --unit mm --t0 UNIX_SECONDS --t1 UNIX_SECONDS tds-response.json > messages.jsonl');
        const body = JSON.parse(readFileSync(args[0], 'utf8'));
        const lines = convert(body, {
            deviceUuid: flags['--device-uuid'], meteringCode: flags['--metering-code'],
            media: flags['--media'], unit: flags['--unit'],
            t0: Number(flags['--t0']), t1: Number(flags['--t1']),
        });
        // Validate the whole response BEFORE writing anything to stdout.
        if (lines.length) process.stdout.write(lines.join('\n') + '\n');
    } catch (error) {
        console.error(`TDS backfill conversion failed: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { convert };
