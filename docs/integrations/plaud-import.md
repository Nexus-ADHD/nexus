# PLAUD import vertical slice

## Scope

This private Settings flow connects to the official PLAUD MCP service, lists the
first page of cloud-synced recordings, and imports one recording selected by the
user. Nexus fetches transcript text only, generates review proposals, and writes
only approved task proposals through the existing Inbox action.

It does not create Inbox items automatically, scan a full PLAUD history, request
or store audio, run transcription, replace deeper Personal OS interpretation,
or add anything to the Inbox without approval.

**Availability (owner-approved 2026-08-15):** the Settings row is offered in
ordinary production builds and lives under **Connect AI**, not Integrations,
because it is the same idea as that row: an outside brain reading your Nexus.
`isPlaudImportAvailable` now returns `true` unconditionally; the seam and its
arguments are kept so re-gating is a one-line change. Public rollout still
depends on the Privacy section below being satisfied.

## Architecture

- OAuth authorization code with PKCE uses PLAUD's published discovery metadata.
- PLAUD dynamically registers a public Nexus client for `nexus://oauth/plaud`.
- No PLAUD API key, client secret, webhook secret, or server deployment is used.
- Access and refresh tokens live in iOS Keychain through `expo-secure-store`,
  scoped by the signed-in Nexus user id.
- The MCP client can call only `list_files`, `get_transcript`, and
  `get_current_user`. The product flow uses only the first two.
- Raw recording responses are immediately projected to id, title, date, and
  duration. Device serial numbers and other raw fields are not retained.
- Transcript pages are assembled in memory. Nexus does not persist the full
  transcript, but each proposal keeps a short verbatim `evidence.quote` from the
  source (`live-interpreter-core.ts:55`, `store.ts:24-30`) so the user can check
  a suggestion against what was actually said. Those excerpts are device-local
  and are never sent to Nexus servers. See `docs/privacy/data-collection.md`.
- Proposal generation uses the existing authenticated Nexus AI proxy and the
  `QUICK_PARSE` model tier. The proxy logs metrics only, but transcript text is
  sent to the configured AI provider to produce the result.
- Evidence segment and quote anchors produce stable proposal keys. Re-importing
  unchanged text reuses the saved interpretation and approved Inbox receipts.

### Retry and backoff

PLAUD asked that we handle rate limits and transient service errors with proper
retry and backoff before a build reaches App Store review. `plaud-mcp.ts` does
this, sharing one policy definition with the app's AI client
(`src/utils/retry-policy.ts`) rather than keeping a second copy:

- Up to 3 attempts (the first plus two retries), 300ms / 800ms / 1800ms apart
  with +/-20% jitter so concurrent clients do not resynchronise.
- Retries `408`, `429`, `500`, `502`, `503` and `504`, plus genuine transport
  failures (`PlaudNetworkError`) and our own per-attempt timeout.
- **Deterministic failures fail immediately.** If PLAUD returns a response we
  cannot use — malformed body, JSON-RPC protocol error, mismatched response id,
  tool-level rejection — an identical retry produces an identical bad response,
  so it surfaces at once rather than costing three authenticated calls. The
  retry decision is an allowlist for this reason, not "any thrown error".
- Honors a `Retry-After` header when PLAUD sends one, capped at 10s.
- Open question for PLAUD: whether rate limits are ever signalled inside a
  JSON-RPC error envelope with HTTP 200 rather than as `429`. If so those would
  currently fail fast. We have not guessed at their error codes; this is
  question 4 in `plaud-authorization-request.md`.
- **Never retries `401`** — that means the access token expired, and
  `plaud-client.ts` handles it a layer up by refreshing and reissuing the call.
  Other 4xx are our own bad request and fail fast.
- The whole sequence is bounded at 45s, and each attempt's timeout shrinks to
  whatever is left, so a retry can never push past that.

Known bound: `get_transcript` paginates, and each page carries its own budget,
so a large transcript under sustained rate limiting can take minutes. Retrying
per page is deliberate — if PLAUD is rate-limiting us, failing fast returns no
transcript either.

## Local setup

PLAUD requires no environment variables. Existing Nexus auth and AI proxy
configuration must be present. Example names, without values:

```dotenv
EXPO_PUBLIC_SUPABASE_URL=
EXPO_PUBLIC_SUPABASE_ANON_KEY=
EXPO_PUBLIC_AI_PROXY_URL=
EXPO_PUBLIC_AI_PROXY_TOKEN=
```

In development, sign in to Nexus and open Settings > PLAUD Import. The local
review fixture remains available only in development as a deterministic test.
The real connector requires a PLAUD account with Cloud Sync enabled.

## TestFlight build

The connector is currently under test in **build 236**, a local Xcode archive
that combines this work with `main`. That build sits on the `production` update
channel, so do not publish an OTA update to `production` at runtime 1.9.0 while
it is the build under review: the embedded bundle would be replaced and this
connector, which is not yet on `main`, would disappear from the installed app.

For an isolated review build instead, the `plaud-review` profile takes the build
number from `app.json`, uses its own EAS Update channel, and reuses the existing
widget build workflow. That workflow signs, archives, and uploads the IPA to App
Store Connect, so do not run a separate submit command.

```bash
npx eas-cli build --platform ios --profile plaud-review --non-interactive
```

The build requires the repository's existing EAS access, Apple signing
credentials, App Store Connect API key, Supabase configuration, and AI proxy
configuration. No new PLAUD credential is required.

After Apple finishes processing:

1. Install build 236 from TestFlight and sign in to Nexus.
2. Enable Cloud Sync in PLAUD and confirm the target recording has a transcript.
3. Open Settings > PLAUD Import and choose Connect.
4. Complete PLAUD authorization in the browser and return to Nexus.
5. Select one recent recording and verify the review appears.
6. For the reviewed acceptance recording, confirm three tasks, one product idea,
   and one context-only operating-system observation.
7. Confirm the observation has no approval control.
8. Approve one task twice and confirm only one Inbox item exists.
9. Approve the remaining tasks, undo one, relaunch, and confirm review state persists.
10. Disconnect PLAUD and confirm the prior review and approved Inbox items remain.

## Privacy

- PLAUD OAuth tokens are Keychain data and are never placed in AsyncStorage,
  logs, crash reports, analytics, or the Nexus cloud snapshot.
- Transcript text is fetched from PLAUD and sent through the Nexus AI proxy to
  the configured AI provider for proposal generation. It is not stored by the
  local import envelope or added to the Nexus cloud snapshot.
- Review proposals remain in account-scoped AsyncStorage on that device.
- Approved tasks enter normal Nexus Inbox persistence and sync.
- No PLAUD audio URL is requested and no audio is downloaded or stored.
- Public rollout remains blocked until PLAUD authorization terms, AI processing
  terms, and the App Store privacy declaration are confirmed.

## Rollback

No database migration or server deployment is required. Before removing the
connector, disconnect PLAUD in Settings to delete the owner-scoped Keychain
token. A code rollback can then remove the Settings row, route, connector
modules, and `plaud-review` profile. Public dynamic-client metadata may remain
in Keychain and is not a credential.

Disconnect removes credentials only. It does not delete local review sessions
or approved Inbox tasks. `clearPlaudImportData` is the separate local-review
cleanup path.

## Known limitations

- Manual selection from only the 20 most recent cloud recordings.
- One recording per import; no background polling or automatic Inbox creation.
- Recordings over 2,000 transcript segments or 60,000 transcript characters are
  rejected, not silently truncated.
- The interpretation is model-generated and always requires review.
- Review state is local to one Nexus account on one device.
- PLAUD advertises no token revocation endpoint. Disconnect deletes local tokens;
  it cannot revoke the refresh token server-side.
- OAuth redirect, transcript import, and Apple processing require the signed
  physical-device TestFlight smoke above.
