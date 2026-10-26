# Tetraedre poller for FlintCORE (DMP)

Read [`docs/FLINTCORE_TETRAEDRE.md`](../docs/FLINTCORE_TETRAEDRE.md) for the source analysis, decisions, open questions and staged rollout plan.

## Use

Create a **device profile** in the FlintCORE profile editor. This directory follows the [official `dmp-device-profiles` layout](https://github.com/orbiwise-sa/dmp-device-profiles): `profile.json` for profile metadata, separate `parametersSchema.json`, `stateSchema.json`, `services.json`, and one file per TypeScript module. Apply the JSON files in their corresponding editor sections and create **four modules** with these exact names (without `.ts`): `main`, `poller`, `sha256`, `types`. Paste each file's content into its module; `main` is the mandatory entry point and imports `poller`, which imports `sha256` and `types` by module name. Do **not** paste only `main.ts`: without its dependencies it cannot run. `profile.json` is *not* a complete `POST /rest/device-profiles` payload by itself. The checked-in `profile_uuid` identifies this profile; generate a different UUID if creating an independent copy. Use the editor's test functionality before saving or deploying. Set no connections.

Create one device for each **confirmed exact** TDS metering code and available media, with these device parameters:

- `url`: full HTTPS TDS endpoint (`.../io/web_service_json.php`), not the public demo server.
- `username`, `dossierId`, and TDS `encryptedPassword` supplied by the TDS administrator. The last is a FlintCORE **secret** parameter; do not put values in source code or logs.
- `meteringCode`: complete TDS measurement code, not `AR_`, `VX_` etc. station prefixes from the email.
- `media`: 7 for rain, 3 temperature, 6 river level, 16 flow (if that station has it). `unit`: confirm in TDS for each series; media 16 has ambiguous generic units.
- `startTimestamp`: first desired UTC Unix timestamp **in seconds**. Default `windowSeconds` is 3600; adjust to stay under 1000 readings per response.

Run `checkAccess`, then `pollNow`, and inspect the live log/upstream messages. The handler runs once per tick (5 minutes), processes one window, and catches up gradually. To test the access response separately, use the service; `checkAccess` does not prove owner-group access—only a successful `get_values` does. Never commit credentials or paste the full authenticated POST body into logs/tickets.

Run local tests with `node --test TetraedrePoller/main.test.cjs` (Node 22+). The local test loader simulates DMP's named-module imports; production uses the platform's module resolver. A successful local test does **not** mean the target server supports the requested format or FlintCORE's sandbox accepts this handler: validate in the target tenant before rollout.
