// Synchronous SHA-256 over ASCII. TDS credentials are hexadecimal ASCII and the challenge
// is decimal ASCII; reject anything else before hashing. Verified against the TDS manual vector.
export function sha256Ascii(text: string): string {
    const primes: number[] = [];
    for (let n = 2; primes.length < 64; n++) {
        let prime = true;
        for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
        if (prime) primes.push(n);
    }
    const frac = (x: number) => (x - Math.floor(x)) * 0x100000000 >>> 0;
    const h = primes.slice(0, 8).map(p => frac(Math.sqrt(p)));
    const k = primes.map(p => frac(Math.cbrt(p)));
    const bytes: number[] = [];
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c > 127) throw new Error("SHA-256 input must be ASCII");
        bytes.push(c);
    }
    const length = bytes.length;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    // The input is deliberately short; append the 64-bit bit-length as two 32-bit words.
    const bits = length * 8;
    if (!Number.isSafeInteger(bits)) throw new Error("SHA-256 input too long");
    const high = Math.floor(bits / 0x100000000), low = bits >>> 0;
    for (const word of [high, low]) for (let shift = 24; shift >= 0; shift -= 8) bytes.push((word >>> shift) & 255);
    const r = (x: number, n: number) => (x >>> n) | (x << (32 - n));
    for (let offset = 0; offset < bytes.length; offset += 64) {
        const w: number[] = [];
        for (let i = 0; i < 16; i++) {
            const j = offset + i * 4;
            w[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
        }
        for (let i = 16; i < 64; i++) {
            const a = w[i - 15], b = w[i - 2];
            w[i] = (w[i - 16] + (r(a, 7) ^ r(a, 18) ^ (a >>> 3)) + w[i - 7] + (r(b, 17) ^ r(b, 19) ^ (b >>> 10))) >>> 0;
        }
        let [a, b, c, d, e, f, g, z] = h;
        for (let i = 0; i < 64; i++) {
            const t1 = (z + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i]) >>> 0;
            const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
            z = g; g = f; f = e; e = (d + t1) >>> 0;
            d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        const round = [a, b, c, d, e, f, g, z];
        for (let i = 0; i < 8; i++) h[i] = (h[i] + round[i]) >>> 0;
    }
    return h.map(x => x.toString(16).padStart(8, "0")).join("");
}
