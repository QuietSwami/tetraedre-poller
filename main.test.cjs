const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { stripTypeScriptTypes } = require('node:module');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { convert } = require('./backfill-jsonl.cjs');

// DMP resolves imports by module name. In the local sandbox simulation, load each
// dependency in the same context, then run the main entry point for every event.
const code = ['sha256', 'poller', 'main'].map(name =>
    stripTypeScriptTypes(readFileSync(`${__dirname}/${name}.ts`, 'utf8'), { mode: 'strip' })
        .replace(/^import .*;\s*$/gm, '')
        .replace(/^export /gm, '')
).join('\n');
const now = 1710000000;
const config = {
    url: 'https://example.test/io/web_service_json.php', username: 'user', dossierId: '123',
    encryptedPassword: '09da4e416785b0270a63e17e8b1313f4e29b814071892fe528060b17c1f0cf09',
    meteringCode: 'AR_EXACT', media: '7', unit: 'mm', startTimestamp: now - 3600,
    windowSeconds: 3600,
};
function invoke(event, { params = config, storage = {}, session = {}, fetchResp, service } = {}) {
    const context = {
        args: { event, fetchResp, service }, info: { params, storage }, result: {}, session,
        Date: class extends Date { static now() { return now * 1000; } }, log() {},
    };
    vm.runInNewContext(code, context);
    return context;
}
test('parameter enum values satisfy the platform schema', () => {
    const openapi = JSON.parse(readFileSync(`${__dirname}/../docs/openapi-schema.json`, 'utf8'));
    const profileSchema = openapi.paths['/rest/device-profiles'].post.requestBody.content['application/json'].schema;
    const itemType = profileSchema.$defs.emptyOrJsonSchemaSchema.properties.enum.items.type;
    const params = JSON.parse(readFileSync(`${__dirname}/parametersSchema.json`, 'utf8'));
    for (const [field, definition] of Object.entries(params.properties)) {
        for (const [index, value] of (definition.enum || []).entries()) {
            assert.equal(typeof value, itemType, `Parameter /parametersSchema/properties/${field}/enum/${index} is of wrong type`);
        }
    }
});

test('official profile layout and named modules are consistent', () => {
    const profile = JSON.parse(readFileSync(`${__dirname}/profile.json`, 'utf8'));
    const params = JSON.parse(readFileSync(`${__dirname}/parametersSchema.json`, 'utf8'));
    const services = JSON.parse(readFileSync(`${__dirname}/services.json`, 'utf8'));
    assert.match(profile.profile_uuid, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    assert.equal(profile.subscribedEvents, 'OnTick,OnFetchResp,OnService');
    assert.equal(profile.periodicTickPeriod, 5);
    assert.equal(profile.minNumOfConnections, 0);
    assert.equal(params.properties.encryptedPassword.$uiSchemaObject.security, 'secret');
    assert.equal(params.properties.media.type, 'string');
    assert.deepEqual(params.properties.media.enum, ['3', '6', '7', '16']);
    assert.deepEqual(services.map(s => s.name), ['checkAccess', 'pollNow']);
    for (const moduleName of ['main', 'poller', 'sha256', 'types']) {
        const source = readFileSync(`${__dirname}/${moduleName}.ts`, 'utf8');
        for (const match of source.matchAll(/^import (?:type )?.* from "([a-zA-Z0-9_-]+)";/gm)) {
            assert.ok(existsSync(`${__dirname}/${match[1]}.ts`), `${moduleName} imports missing ${match[1]}`);
        }
    }
});
function decodedFetch(ctx) { return JSON.parse(ctx.result.fetch.body); }
function plain(x) { return JSON.parse(JSON.stringify(x)); }

test('challenge matches TDS manual vector and standard SHA-256', () => {
    const ctx = invoke('OnTick');
    assert.equal(vm.runInNewContext('sha256Ascii("09da4e416785b0270a63e17e8b1313f4e29b814071892fe528060b17c1f0cf091546027813")', ctx), 'e171c40735aae045353f9ffb617c4307037c17c91263bcd02931e24de3c4613f');
    assert.equal(vm.runInNewContext('sha256Ascii("abc")', ctx), createHash('sha256').update('abc').digest('hex'));
    const p = decodedFetch(ctx);
    assert.equal(p.challenge, now + 60);
    assert.equal(p.challenge_password, createHash('sha256').update(config.encryptedPassword + (now + 60)).digest('hex'));
    assert.equal(p.operation, 'get_values');
    assert.equal(p.metering_code, config.meteringCode);
    assert.equal(p.media, 7);
    assert.equal(typeof p.media, 'number');
    assert.equal(ctx.session.pending.media, 7);
    assert.equal(p.Format, 1);
    assert.equal(p.t0, now - 3600);
    assert.equal(p.t1, now - 1);
    assert.equal(ctx.result.fetch.method, 'post');
});

test('success publishes historic timestamps and advances cursor over inclusive windows', () => {
    const first = invoke('OnTick');
    const resp = invoke('OnFetchResp', { session: first.session, fetchResp: { statusCode: 200, body: { access_granted: 1, Values: [
        { timestamp: now - 3000 + '', value: '0' }, { timestamp: now - 1, value: '2.25' },
    ] } } });
    assert.equal(resp.result.operationalStatus, 'normal');
    assert.deepEqual(plain(resp.result.upstream.map(m => m.object.value)), [0, 2.25]);
    assert.equal(resp.result.upstream[0].object.timestamp, (now - 3000) * 1000);
    assert.equal(resp.result.upstream[0].object.sourceTimestampUs, (now - 3000) * 1000000);
    assert.equal(resp.result.upstream[0].object.unit, 'mm');
    assert.equal(resp.result.storage.nextTimestamp, now);
    const next = invoke('OnTick', { storage: resp.result.storage });
    assert.equal(decodedFetch(next).t0, now);
    assert.equal(decodedFetch(next).t1, now);
});

test('empty response advances; malformed, excessive, and denied responses do not', () => {
    const first = invoke('OnTick');
    const good = invoke('OnFetchResp', { session: first.session, fetchResp: { statusCode: 200, body: JSON.stringify({ access_granted: 1, Values: [] }) } });
    assert.equal(good.result.storage.nextTimestamp, now);
    for (const body of [[], '[]', '42', '{broken', { access_granted: 0, Values: [] }, { access_granted: 1, Values: [{ timestamp: now + 2, value: '1' }] },
        { access_granted: 1, Values: [{ timestamp: now - 1, value: null }] },
        { access_granted: 1, Values: [{ timestamp: now - 1, value: false }] },
        { access_granted: 1, Values: Array.from({ length: 1001 }, () => ({ timestamp: now - 1, value: 1 })) }]) {
        const resp = invoke('OnFetchResp', { session: { ...first.session }, fetchResp: { statusCode: 200, body } });
        assert.equal(resp.result.operationalStatus, 'warning');
        assert.equal(resp.result.storage, undefined);
        assert.equal(resp.result.upstream, undefined);
    }
});

test('AV_ from the station list is accepted verbatim as a metering code', () => {
    const ctx = invoke('OnTick', { params: { ...config, meteringCode: 'AV_', media: '16', unit: 'm3/s' } });
    assert.equal(decodedFetch(ctx).metering_code, 'AV_');
    assert.equal(decodedFetch(ctx).media, 16);
    assert.equal(convert({ access_granted: 1, Values: [{ timestamp: now - 1, value: '0.21' }] }, {
        deviceUuid: '11111111-2222-3333-4444-555555555555', meteringCode: 'AV_',
        media: '16', unit: 'm3/s', t0: now - 3600, t1: now,
    }).length, 1);
});

test('HTTP failure and missing credentials cannot advance or fetch', () => {
    const first = invoke('OnTick');
    const failed = invoke('OnFetchResp', { session: first.session, fetchResp: { statusCode: 403 } });
    assert.equal(failed.result.storage, undefined);
    assert.equal(failed.result.operationalStatus, 'warning');
    const invalid = invoke('OnTick', { params: { ...config, meteringCode: 'AV_?' } });
    assert.equal(invalid.result.fetch, undefined);
    assert.equal(invalid.result.operationalStatus, 'warning');
});

test('historical JSONL uses the documented microsecond message timestamp', () => {
    const options = { deviceUuid: '11111111-2222-3333-4444-555555555555', meteringCode: 'AR_EXACT', media: '7', unit: 'mm', t0: now - 3600, t1: now };
    const body = { access_granted: '1', Values: [{ timestamp: String(now - 2), value: '0' }, { timestamp: now, value: '2.25' }] };
    const lines = convert(body, options).map(line => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].timestamp, (now - 2) * 1000000);
    assert.equal(lines[0].data_type, 'object');
    assert.deepEqual(JSON.parse(lines[0].data), {
        source: 'tetraedre', meteringCode: 'AR_EXACT', media: 7,
        timestamp: (now - 2) * 1000, sourceTimestampUs: (now - 2) * 1000000,
        value: 0, unit: 'mm',
    });
    assert.throws(() => convert({ access_granted: 0, Values: [] }, options));
    assert.throws(() => convert({ access_granted: 1, Values: [{ timestamp: now + 1, value: 5 }] }, options));
    assert.throws(() => convert({ access_granted: 1, Values: [{ timestamp: now, value: false }] }, options));
});

test('backfill CLI writes JSONL only after validating the entire response', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tds-backfill-'));
    try {
        const path = join(dir, 'tds-response.json');
        const cmd = [join(__dirname, 'backfill-jsonl.cjs'), '--device-uuid', '11111111-2222-3333-4444-555555555555', '--metering-code', 'AR_EXACT', '--media', '7', '--unit', 'mm', '--t0', String(now - 3600), '--t1', String(now), path];
        writeFileSync(path, JSON.stringify({ access_granted: 1, Values: [{ timestamp: now - 1, value: '1' }] }));
        const ok = spawnSync(process.execPath, cmd, { encoding: 'utf8' });
        assert.equal(ok.status, 0, ok.stderr);
        assert.equal(JSON.parse(ok.stdout.trim()).timestamp, (now - 1) * 1000000);
        writeFileSync(path, JSON.stringify({ access_granted: 1, Values: [{ timestamp: now - 1, value: '1' }, { timestamp: now + 1, value: '2' }] }));
        const bad = spawnSync(process.execPath, cmd, { encoding: 'utf8' });
        assert.equal(bad.status, 1);
        assert.equal(bad.stdout, '');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('checkAccess verifies export_data and does not move cursor', () => {
    const first = invoke('OnService', { service: { checkAccess: {} } });
    assert.equal(decodedFetch(first).operation, 'check_access');
    const resp = invoke('OnFetchResp', { session: first.session, fetchResp: { statusCode: 200, body: JSON.stringify({ access_granted: 1, export_data: '1' }) } });
    assert.equal(resp.result.operationalStatus, 'normal');
    assert.equal(resp.result.storage, undefined);
});
