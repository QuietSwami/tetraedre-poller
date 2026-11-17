import { sha256Ascii } from "sha256";
import type { PollConfig, Cursor, Row } from "types";

function config(): PollConfig {
    const p = info.params as any;
    if (!p || typeof p.url !== "string" || !/^https:\/\/[^/?#]+\/io\/web_service_json\.php$/.test(p.url)) throw new Error("Configure an HTTPS TDS endpoint ending in /io/web_service_json.php");
    if (typeof p.username !== "string" || !p.username || typeof p.dossierId !== "string" || !p.dossierId) throw new Error("Configure username and dossierId");
    if (typeof p.encryptedPassword !== "string" || !/^[0-9a-f]{64}$/i.test(p.encryptedPassword)) throw new Error("Configure a 64-character encryptedPassword");
    if (typeof p.meteringCode !== "string" || !/^[A-Za-z0-9_-]{2,100}$/.test(p.meteringCode)) throw new Error("Configure a valid TDS meteringCode");
    // The profile schema uses string enum values (DMP requires string enum items),
    // while the TDS JSON API expects a numeric media identifier.
    const media = typeof p.media === "string" && /^(3|6|7|16)$/.test(p.media) ? Number(p.media) : p.media;
    if (![3, 6, 7, 16].includes(media)) throw new Error("Invalid media");
    if (typeof p.unit !== "string" || !p.unit.trim() || p.unit.length > 30) throw new Error("Configure the verified measurement unit");
    if (!Number.isSafeInteger(p.startTimestamp) || p.startTimestamp < 0) throw new Error("Configure startTimestamp in Unix seconds");
    // JSON Schema defaults are UI hints, not guaranteed runtime values.
    const windowSeconds = p.windowSeconds ?? 3600;
    if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 60 || windowSeconds > 86400) throw new Error("windowSeconds must be 60..86400");
    return { ...p, media, windowSeconds } as PollConfig;
}

function fingerprint(c: PollConfig): string {
    // Changing feed identity invalidates the old cursor; credentials may rotate independently.
    return JSON.stringify([c.url, c.dossierId, c.meteringCode, c.media, c.unit]);
}

export function fail(reason: string): void {
    log(`[TDS] ${reason}`); // Never log requests, responses, or credentials.
    result.operationalStatus = "warning";
}

function request(c: PollConfig, operation: string, extra: object): void {
    const challenge = Math.floor(Date.now() / 1000) + 60;
    const payload = {
        operation, username: c.username, dossier_id: c.dossierId,
        challenge, challenge_password: sha256Ascii(c.encryptedPassword.toLowerCase() + String(challenge)),
        ...extra,
    };
    result.fetch = {
        url: c.url, method: "post",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(payload),
    };
}

export function handleOnTick(): void {
    const c = config();
    const stored = (info.storage || {}) as Cursor;
    const key = fingerprint(c);
    const next = stored.fingerprint === key && Number.isSafeInteger(stored.nextTimestamp) ? Math.max(c.startTimestamp, stored.nextTimestamp!) : c.startTimestamp;
    const now = Math.floor(Date.now() / 1000);
    if (next > now) return;
    const end = Math.min(next + c.windowSeconds - 1, now);
    // session persists through fetch -> OnFetchResp; storage is committed only after validation.
    session.pending = { operation: "get_values", start: next, end, fingerprint: key, media: c.media, meteringCode: c.meteringCode, unit: c.unit };
    request(c, "get_values", {
        metering_code: c.meteringCode, t0: next, t1: end,
        limit: 0, sort: "ASC", media: c.media, format: 1,
    });
}

export function handleOnService(): void {
    if (args.service?.checkAccess) {
        const c = config();
        session.pending = { operation: "check_access" };
        request(c, "check_access", {});
    } else if (args.service?.pollNow) handleOnTick();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function handleOnFetchResp(): void {
    const pending = session.pending;
    session.pending = undefined;
    if (!pending) { fail("Unexpected fetch response"); return; }
    const resp = args.fetchResp;
    const status = resp?.statusCode;
    if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status >= 300) { fail("HTTP request failed"); return; }
    let body: unknown = resp?.body;
    if (typeof body === "string") {
        try { body = JSON.parse(body); } catch { fail("Invalid JSON response"); return; }
    }
    if (pending.operation === "check_access") {
        if (isRecord(body) && body.access_granted == 1 && body.export_data == 1) {
            log("[TDS] Access and export_data confirmed; measurement-set owner-group access still needs a get_values test");
            result.operationalStatus = "normal";
        } else fail("Access denied or export_data missing");
        return;
    }
    let rows: Row[];
    if (Array.isArray(body)) {
        // TDS format 0 has no access_granted flag. Non-empty, valid readings prove this
        // request could read data; an empty array might instead mean denied access.
        if (body.length === 0) { fail("Empty format-0 response: cannot distinguish no data from denied access"); return; }
        rows = body as Row[];
    } else if (isRecord(body)) {
        if (body.access_granted != 1 || !Array.isArray(body.Values ?? body.values)) { fail("Access denied or unexpected get_values response (format=1 required)"); return; }
        rows = (body.Values ?? body.values) as Row[];
    } else {
        fail(`Unexpected TDS response body (${body === null ? "null" : typeof body})`);
        return;
    }
    if (rows.length > 1000) { fail("Window returned >1000 values; reduce windowSeconds (cursor unchanged)"); return; }
    const upstream: { type: "object"; object: Record<string, string | number> }[] = [];
    let previous = pending.start - 1;
    for (const row of rows) {
        const t = Number(row?.timestamp), v = Number(row?.value);
        if (!Number.isSafeInteger(t) || t < pending.start || t > pending.end || t < previous || !["string", "number"].includes(typeof row.value) || (typeof row.value === "string" && !row.value.trim()) || !Number.isFinite(v)) {
            fail("Malformed, unsorted, or out-of-window TDS reading (cursor unchanged)"); return;
        }
        const sourceTimestampUs = t * 1000000;
        if (!Number.isSafeInteger(sourceTimestampUs)) { fail("Source timestamp exceeds safe microsecond precision (cursor unchanged)"); return; }
        previous = t;
        upstream.push({ type: "object", object: {
            source: "tetraedre", meteringCode: pending.meteringCode, media: pending.media,
            // Payload fields only; upstream's message timestamp is assigned by FlintCORE.
            timestamp: t * 1000, sourceTimestampUs, value: v, unit: pending.unit,
        }});
    }
    if (upstream.length) result.upstream = upstream;
    // Inclusive [t0,t1] ranges: +1 avoids duplicates at window boundaries.
    result.storage = { ...info.storage, fingerprint: pending.fingerprint, nextTimestamp: pending.end + 1 };
    result.operationalStatus = "normal";
    result.touch = true;
}
