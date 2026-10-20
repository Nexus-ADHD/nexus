# What Nexus collects — the source of truth

**This file is authoritative.** `app.json` `ios.privacyManifests` and the App Store Connect
privacy label must both match it. Every row is evidence-backed with `file:line`; nothing here
is inferred from the privacy policy, because the policy was wrong in three places when this was
first written (2026-08-15).

Update this file when a data flow changes, then update the manifest and the ASC label from it.
The ASC label cannot be read or written through the API (`v1/appDataUsages` returns
`PATH_ERROR: the resource does not exist`), so it stays a manual mirror. The checklist at the
bottom exists so that mirroring is mechanical.

## The identity that makes almost everything "linked"

The **Supabase Auth user UUID** is the account identifier. It starts as an anonymous Supabase
user (`app/_layout.tsx:2296`) and is *preserved* through sign-in via `linkIdentityWithIdToken`
(`src/features/auth/auth-screen.tsx:112,183`), so one UUID spans pre-auth and post-auth.

It is then handed to two third parties:

- `posthog.identify(userId)` — `app/_layout.tsx:1874`
- `Purchases.logIn(userId)` as the RevenueCat App User ID — `src/services/revenuecat.ts:446`,
  plus `$posthogUserId` as a subscriber attribute — `src/services/revenuecat.ts:137`

**Consequence:** analytics and purchase data are *Linked to the User* even though the UUID is
not a name or email. Do not declare them unlinked.

**The exception is Sentry**, which is deliberately unlinked: no `setUser` call exists anywhere,
`sendDefaultPii: false`, and `beforeSend` does `delete event.user`
(`src/sentry-init.ts:59,60-66`).

## Collected data

| Apple data type | What it actually is | Linked | Tracking | Purpose | Evidence |
|---|---|---|---|---|---|
| **Email Address** | Supabase Auth identity; `nexus_profiles.email`; delivery address at Resend | yes | no | App Functionality | `auth-screen.tsx:163-167`, `nexus-profiles.ts:32-41`, `welcome-email/index.ts:124,132` |
| **Name** | Written to auth user metadata and `nexus_profiles.name` | yes | no | App Functionality | `auth-screen.tsx:56-58`, `upsert-profile/index.ts:82-105` |
| **Phone Number** | Optional. `user_profile.phone_number` in E.164; sent to Twilio for SMS | yes | no | App Functionality | `app/_layout.tsx:803`, `sms-opt-in-sheet.tsx:140`, `sms-webhook/index.ts:2-30` |
| **Audio Data** | The Command orb records m4a and uploads it to OpenAI Whisper. This is the **primary** transcription path; on-device recognition is a live preview and a fallback | yes | no | App Functionality | `app/(tabs)/index.tsx:1614,1657`, `ai-client.ts:497-499`, `ai-proxy/index.ts:535-543` |
| **Other User Content** | Mandates and their free-text notes, reflections, intentions, task titles, connected-calendar event titles, PLAUD transcripts. Synced to Supabase and sent to the AI provider | yes | no | App Functionality, Product Personalization | `cloud-sync-payload.ts:7-59`, `ai-context.ts:203-224`, `home-screen.tsx:1160-1183`, `plaud-import/live-interpreter.ts:47-53` |
| **User ID** | The Supabase UUID, given to PostHog and RevenueCat | yes | no | App Functionality, Analytics | `app/_layout.tsx:1874`, `revenuecat.ts:446` |
| **Purchase History** | Subscription state via RevenueCat | yes | no | App Functionality | `revenuecat.ts:156,446` |
| **Product Interaction** | 20 named events with opaque ids and no content. Consent-gated | yes | no | Analytics | `analytics.ts:28-66`, gate at `app/_layout.tsx:1672` |
| **Advertising Data** | Apple Search Ads attribution token, passed to RevenueCat and joined to the account id. No IDFA, no ATT prompt | yes | no | Developer's Advertising or Marketing | `revenuecat.ts:167` |
| **Crash Data** | Sentry | **no** | no | App Functionality | `sentry-init.ts:40,59,60-66` |
| **Performance Data** | Sentry | **no** | no | App Functionality | same |
| **Other Diagnostic Data** | Sentry | **no** | no | App Functionality | same |

**Tracking is `false` for every row.** No IDFA, no ATT prompt, no cross-app or cross-site
tracking, and no sharing with data brokers.

## Not collected, and worth keeping that way

- **No audio is retained** after transcription completes.
- **The full PLAUD transcript is not stored, but verbatim excerpts are.** Each proposal keeps an
  evidence `quote` resolved to exact source text (`live-interpreter-core.ts:55`), persisted in
  the envelope (`store.ts:24-30`). That excerpt is the feature: it is how the user checks a
  proposal against what they actually said. It is **device-local** and deliberately absent from
  `buildCloudSyncPayload`, so it never reaches Supabase. Approved task *titles* do reach Supabase
  through the Inbox (`plaud-import/approval.ts:12-24`), which is why Other User Content is
  declared.

  *Caught by review 2026-08-15: an earlier draft of this file and both policy copies claimed
  transcripts were not stored at all. They were wrong about the evidence quote.*
- **No user content reaches analytics.** PostHog touch autocapture is off *because* it captured
  `children` into `$el_text` and would have sent mandate titles (`app/_layout.tsx`, see the
  comment on `captureTouches`). If anyone turns it back on, this row becomes false.
- **Calendar notes and locations are not sent** to the AI provider. Only event titles.
- **Braintrust receives metrics only** — token counts and model/provider enums, no message text
  and no user identifier (`ai-proxy/index.ts`, `startMetricsSpan`; the `/tts` span records the
  provider attempted and served, the reason, character count and latency, never the text).
- **The coach's spoken reply is synthesized by ElevenLabs** (`ai-proxy/index.ts`, `handleTts`),
  with OpenAI `gpt-4o-mini-tts` as the fallback when ElevenLabs is unconfigured, disabled, over
  quota or failing. The text sent is the model's own reply, which can paraphrase or echo what the
  person said in that turn; it is never the raw transcript. **ElevenLabs retains the text and the
  generated audio in the account's History on the Creator plan** (zero-retention mode is an
  Enterprise feature; verified 2026-09-04 against the plan's feature list). It is not used for
  training under ElevenLabs' API terms. No user identifier accompanies the request.

## Third parties that receive personal data

Supabase (auth + storage) · OpenAI, Anthropic, Moonshot (AI, routed by model id) · ElevenLabs
(the coach's spoken reply; OpenAI is the fallback voice) · PostHog
(analytics, consent-gated) · RevenueCat (subscriptions + install attribution) · Twilio (SMS) ·
Resend (email) · Braintrust (AI metrics only) · Sentry (diagnostics) · PLAUD (read-only, user
connects it) · Google/Microsoft (calendar, user connects it) · Apple (Search Ads attribution,
and server-side speech recognition when the on-device locale is unavailable,
`use-live-transcription.ts:197-213`).

## App Store Connect checklist

ASC → the app → **App Privacy**. There is no API for this; it must be entered by hand. Set
every row below. **Linked** and **Tracking** are separate questions from collection, and the
Linked answers are the ones most often wrong.

- [ ] Contact Info → **Email Address** — collected, linked, not tracking, App Functionality
- [ ] Contact Info → **Name** — collected, linked, not tracking, App Functionality
- [ ] Contact Info → **Phone Number** — collected, linked, not tracking, App Functionality
- [ ] User Content → **Audio Data** — collected, linked, not tracking, App Functionality
- [ ] User Content → **Other User Content** — collected, linked, not tracking, App Functionality + Product Personalization
- [ ] Identifiers → **User ID** — collected, linked, not tracking, App Functionality + Analytics
- [ ] Purchases → **Purchase History** — collected, linked, not tracking, App Functionality
- [ ] Usage Data → **Product Interaction** — collected, linked, not tracking, Analytics
- [ ] Usage Data → **Advertising Data** — collected, linked, not tracking, Developer's Advertising
- [ ] Diagnostics → **Crash Data** — collected, **not** linked, not tracking, App Functionality
- [ ] Diagnostics → **Performance Data** — collected, **not** linked, not tracking, App Functionality
- [ ] Diagnostics → **Other Diagnostic Data** — collected, **not** linked, not tracking, App Functionality

### The one judgment call

**Advertising Data.** `enableAdServicesAttributionTokenCollection()` uses Apple's AdServices
API, not the IDFA, and shows no ATT prompt. The token is nonetheless passed to RevenueCat and
joined to the account id, so it is declared here rather than omitted. Declaring is the
conservative reading; if you would rather not carry an advertising row on the label, the
alternative is to remove the call (`src/services/revenuecat.ts:167`) and lose Search Ads
attribution. **Do not simply drop the declaration while keeping the call.**

## Still unverified

- **Supabase Auth's own retained fields** (last sign-in IP, provider identity payloads) live in
  `auth.users`, outside this repo and outside `export-account`'s table list
  (`export-account/index.ts:33-43`). Not reviewed.
- **Whether any external calendar event is persisted** into `orbitDays` and therefore into
  `user_state`. No such writer was found, but not every `orbitDays` mutation was traced. If one
  exists, calendar content is stored as well as transmitted.
