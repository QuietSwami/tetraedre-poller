export type PollConfig = {
    url: string;
    username: string;
    dossierId: string;
    encryptedPassword: string;
    meteringCode: string;
    media: number;
    unit: string;
    startTimestamp: number;
    windowSeconds: number;
};

export type Cursor = { nextTimestamp?: number; fingerprint?: string };
export type Row = { timestamp: string | number; value: string | number | null };
