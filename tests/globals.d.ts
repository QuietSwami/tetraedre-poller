// Local TypeScript compilation only: FlintCORE injects these globals at runtime.
// Keep fetchResp.body broad to catch unsafe response-property access before UI import.
declare const info: { params: unknown; storage: Record<string, unknown> };
declare const args: {
    event: string;
    service?: Record<string, unknown>;
    fetchResp?: { statusCode?: number; body?: string | object };
};
declare const result: {
    fetch?: unknown;
    upstream?: object[];
    storage?: unknown;
    operationalStatus?: string;
    touch?: boolean;
};
declare const session: { pending?: any };
declare function log(value: string): void;
