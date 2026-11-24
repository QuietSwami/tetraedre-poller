export type PollConfig = {
    url: string;
    username: string;
    dossierId: string;
    encryptedPassword: string;
    meteringCode: string;
    media: number;
    unit: string; // Derived from media by config(); not a device parameter.
    startTimestamp: number;
    windowSeconds: number;
};

export type Cursor = { nextTimestamp?: number; fingerprint?: string };
export type Row = { timestamp: string | number; value: string | number | null };
