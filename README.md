# Tetraedre poller for FlintCORE (DMP)

The broader workspace includes `docs/FLINTCORE_TETRAEDRE.md` (analysis and rollout plan) and the 2026 `docs/DMP-Customer-Manual-en.pdf` (especially §§2.4, 7.2, 12.4 and 12.6). Those documents are not part of this standalone Git repository.

## Use

Create a **device profile** in the FlintCORE profile editor. This directory follows the [official `dmp-device-profiles` layout](https://github.com/orbiwise-sa/dmp-device-profiles): `profile.json` for profile metadata, separate `parametersSchema.json`, `stateSchema.json`, `services.json`, and one file per TypeScript module. When importing **this Git repository**, the only `.ts` files are `main.ts`, `poller.ts`, `sha256.ts` and `types.ts` at the root. Their DMP module names must be the corresponding bare names: `main`, `poller`, `sha256`, `types`. Test-only TypeScript declarations were removed from the repository tree because the Git importer treated the nested path as an invalid module name. If configuring manually, paste all four files into those named modules; `main` imports `poller`, which imports `sha256` and `types`. `profile.json` is *not* a complete `POST /rest/device-profiles` payload by itself. The checked-in `profile_uuid` identifies this profile; generate a different UUID if creating an independent copy. Use the editor's test functionality before saving or deploying. Set no connections.

Create one device for each **confirmed exact** TDS metering code and available media, with these device parameters:

- `url`: full HTTPS TDS endpoint (`.../io/web_service_json.php`), not the public demo server. The handler separately checks this shape in `poller.ts`; changing the parameter schema's `pattern` alone does not change that runtime check. If OCEau supplies a different URL shape, confirm the actual JSON API endpoint before adapting both checks.
- `username`, `dossierId`, and TDS `encryptedPassword` supplied by the TDS administrator. The last is a FlintCORE **secret** parameter; do not put values in source code or logs.
- `meteringCode`: the TDS metering code as given by the station owner; codes such as `AV_` and `VX_` have trailing underscores, which the handler accepts. For `AV_`, the public site displays measurement set ID 23, but verify that the authenticated API accepts `AV_` for your account.
- `media`: choose `7` for rain, `3` temperature, `6` river level, or `16` flow (if that station has it). DMP's profile schema requires **string enum values**; the handler converts the chosen string to a number for TDS. `unit`: confirm in TDS for each series; media 16 has ambiguous generic units.
- `startTimestamp`: first desired UTC Unix timestamp **in seconds**. `windowSeconds` is optional; when omitted, the handler uses **3600 seconds**. If supplied, it must be an integer from 60 to 86400; adjust it to stay under 1000 readings per response.

Run `checkAccess`, then `pollNow`, and inspect the live log/upstream messages. The handler runs once per tick (5 minutes), processes one window, and catches up gradually. To test the access response separately, use the service; `checkAccess` does not prove owner-group access—only a successful `get_values` does. Never commit credentials or paste the full authenticated POST body into logs/tickets. **Important:** the upstream object's `timestamp` (milliseconds) and `sourceTimestampUs` (microseconds) are *payload fields*; they do not set the indexed FlintCORE message timestamp. For source-time-indexed historical data, use the separate batch import process below.

## Historical backfill (optional; do not overlap with live polling)

The 2026 FlintCORE manual (§7.2.3.2) documents a **separate** JSONL message import path with a top-level Unix-**microsecond** timestamp. After registering the target device, save a single bounded, authorized TDS `get_values` **format-1** response to a private JSON file and convert it offline (no TDS/FlintCORE credentials needed by the converter):

```sh
node backfill-jsonl.cjs \
  --device-uuid 'YOUR-REGISTERED-DEVICE-UUID' \
  --metering-code 'YOUR-EXACT-TDS-CODE' --media 7 --unit mm \
  --t0 1709852400 --t1 1709938800 \
  tds-response.json > messages.jsonl
```

Use the actual inclusive `t0`/`t1` of that TDS request; the converter rejects unauthorized, malformed, unsorted or out-of-window readings and verifies all rows before writing output. Upload the `.jsonl` via Devices → Import (`/app/import`) and check `/app/import-jobs` for failures. Start with a small pilot; the manual recommends exporting a real device/message first to confirm the import shape in your tenant. Don't upload both JSONL and live-poller data for the **same** period without an explicit deduplication strategy. Do not put TDS secrets in JSONL import records.

From this Git repository's root, run `node tests/typecheck.cjs` to check TypeScript against temporary sandbox globals (uses `npx` and TypeScript 5.9.3); these declarations are for local tests only, not a substitute for the tenant's live type definitions. Run behavior tests with `node --test main.test.cjs` (Node 22+). The local test loader simulates DMP's named-module imports; production uses the platform's module resolver. A successful local test does **not** mean the target server supports the requested format or FlintCORE's sandbox accepts this handler: validate in the target tenant before rollout.
