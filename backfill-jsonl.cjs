#!/usr/bin/env node
// Convert ONE saved TDS get_values response (format 1 or non-empty format 0) into FlintCORE historical
// message import records. This does not call TDS or FlintCORE and needs no secrets.
const { readFileSync } = require('node:fs');

// OCEAU-specific labels; mirror poller.ts. This does not convert numeric values.
const UNIT_BY_MEDIA = { 3: '°C', 6: 'm', 7: 'mm', 16: 'm3/s' };

function convert(body, options) {
    const { deviceUuid, meteringCode, media, t0, t1 } = options;
    if (typeof deviceUuid !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(deviceUuid)) throw new Error('Invalid device UUID');
    if (typeof meteringCode !== 'string' || !/^[A-Za-z0-9_-]{2,100}$/.test(meteringCode)) throw new Error('Use a valid TDS metering code');
    if (!/^(3|6|7|16)$/.test(String(media))) throw new Error('Invalid media');
    // The public OFEV/SIG absolute-level series are in metres above sea level,
    // unlike OCEAU's relative level in metres. No other override is permitted.
    if (options.unitOverride !== undefined && (String(media) !== '6' || options.unitOverride !== 'm s.m.')) {
        throw new Error('Only media 6 may override its unit to m s.m.');
    }
    const unit = options.unitOverride ?? UNIT_BY_MEDIA[Number(media)];
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
        const allowed = ['--device-uuid', '--metering-code', '--media', '--t0', '--t1'];
        while (args.length > 1 && args[0].startsWith('--')) {
            const key = args.shift(), value = args.shift();
            if (!allowed.includes(key) || !value || flags[key] !== undefined) throw new Error('Invalid or duplicate argument');
            flags[key] = value;
        }
        if (args.length !== 1 || Object.keys(flags).length !== allowed.length) throw new Error('Usage: node backfill-jsonl.cjs --device-uuid UUID --metering-code CODE --media 7 --t0 UNIX_SECONDS --t1 UNIX_SECONDS tds-response.json > messages.jsonl');
        const input = readFileSync(args[0], 'utf8');
        if (!input.trim()) throw new Error('Input file is empty or contains no JSON; save only the TDS get_values response body');
        let body;
        try { body = JSON.parse(input); }
        catch { throw new Error('Invalid JSON response file (possibly truncated); save only the TDS get_values response body'); }
        const lines = convert(body, {
            deviceUuid: flags['--device-uuid'], meteringCode: flags['--metering-code'],
            media: flags['--media'],
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
