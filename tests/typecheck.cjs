#!/usr/bin/env node
// Run a strict local TypeScript check without adding .ts/.d.ts fixtures to the
// Git-imported device profile. DMP supplies these globals inside its sandbox.
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const profileDir = join(__dirname, '..');
const tempDir = mkdtempSync(join(tmpdir(), 'tds-typecheck-'));
try {
    const globals = join(tempDir, 'globals.d.ts');
    writeFileSync(globals, `// FlintCORE generates required TypeScript properties even for optional state schema fields.
interface DeviceState {
    latestValue: number;
    latestTimestampMs: number;
    unit: string;
    lastSuccessfulPollMs: number;
}
declare const info: { params: unknown; storage: Record<string, unknown>; state?: DeviceState };
declare const args: {
    event: string;
    service?: Record<string, unknown>;
    fetchResp?: { statusCode?: number; body?: string | object };
};
interface MessageBlock {
    type: 'object' | 'string' | 'octets';
    timestamp?: number; // Operator-confirmed upstream Unix milliseconds override.
    object?: object;
}
declare const result: {
    fetch?: unknown;
    upstream?: MessageBlock[];
    storage?: unknown;
    state?: DeviceState;
    operationalStatus?: string;
    touch?: boolean;
};
declare const session: { pending?: any };
declare function log(value: string): void;
`);
    const project = join(tempDir, 'tsconfig.json');
    writeFileSync(project, JSON.stringify({
        compilerOptions: {
            strict: true, noEmit: true, target: 'ES2022', module: 'commonjs',
            moduleResolution: 'node', baseUrl: profileDir, skipLibCheck: true,
        },
        files: ['main.ts', 'poller.ts', 'sha256.ts', 'types.ts'].map(name => join(profileDir, name)).concat(globals),
    }));
    const result = spawnSync('npx', ['--yes', '--package', 'typescript@5.9.3', 'tsc', '--project', project], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
} finally {
    rmSync(tempDir, { recursive: true, force: true });
}
