# Nexus

I'm on a pursuit to master my habits. This is the app I built to do it.

It's free and open source because anything can be rebuilt with one prompt now, so let's build the best version together.

- App Store: TODO link
- YouTube, Mastering AI: TODO link
- Discord: TODO link

## What Nexus does

Nexus is an iOS app. You say or type what you need to do, and it turns that into the right thing: a task, a habit, a calendar block, a reminder, or a goal.

The loop is simple.

1. Speak or type a command.
2. Nexus reads the intent.
3. A review card shows what it is about to do.
4. You confirm, edit, or cancel.
5. The action lands where it belongs, and Home updates right away.

Examples:

- "Block a workout every weekday at 6 AM" becomes a recurring habit.
- "Dinner with Sam Friday at 7" becomes a calendar event.
- "Remind me to call Mom tomorrow" becomes a to-do.
- "Add write the book as a vision goal" becomes a goal.

The main screens:

- **Home.** Today's habits, your score, and what is coming up.
- **Command.** The voice and text input. This is the center of the app.
- **Orbit.** Your schedule. Recurring blocks and calendar events in one place, synced with Apple Calendar.
- **Inbox.** Quick captures waiting for a decision.
- **Align.** Your mandates (the few identities you are building) and the goals under them.

Also in the app:

- **Coach.** Talk a problem through, then Nexus writes the plan and you approve it.
- **This Week.** A weekly review and plan.
- **Trophies.** Streaks and milestones.
- **Widgets and Apple Watch.** Check off habits without opening the app.
- **Imports.** Apple Reminders and PLAUD voice recordings, always with review before anything is added.
- **Connect AI.** Link ChatGPT or Claude to your Nexus account. This needs a separate MCP server that is not in this repo yet.

Nothing writes to your calendar or goals without a review card first.

## How it is built

| Layer | Tech |
|---|---|
| App | React Native, Expo 54, Expo Router |
| State | Zustand, one store in `src/state/app-state.ts` |
| Backend | Supabase (auth, Postgres, edge functions) |
| AI | The `ai-proxy` edge function. The app never holds a model provider key. |
| Subscriptions | RevenueCat |
| Native | WidgetKit widget and watchOS app in Swift (`native-targets/`) |
| Analytics and crashes | PostHog and Sentry, both optional |

Layout:

```
app/                  screens (Expo Router, file based)
src/features/         feature code: command, coach, orbit, home, onboarding, and more
src/state/            the store and selectors
src/services/         Supabase, sync, notifications, analytics, billing
src/utils/ai-client.ts  every AI call goes through here, to the proxy
native-targets/       Swift widget, watch app, and the widget reload bridge
supabase/migrations/  database schema
supabase/functions/   edge functions (AI proxy, account export and delete, emails, SMS)
scripts/              build helpers and repo guards used by CI
```

## Run it locally

You need Node 20, Xcode, and a free Supabase project. Widgets, Apple Sign-In, and Apple Calendar need a development build on a real device. Most of the app runs in the iOS simulator.

### 1. Install

```bash
git clone TODO-repo-url nexus
cd nexus
npm install
```

### 2. Set up Supabase

Install the [Supabase CLI](https://supabase.com/docs/guides/local-development), then link your project and push the schema:

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

The migrations in `supabase/migrations/` create every table the app uses. The first one, `20260401000000_baseline_core_tables.sql`, creates the core tables (`user_state`, `nexus_profiles`, `nexus_email_log`) and the AI rate limiter that the rest build on.

Deploy the AI proxy and set its secrets:

```bash
supabase secrets set AI_PROXY_APP_TOKEN=<long-random-string> ANTHROPIC_API_KEY=<key> OPENAI_API_KEY=<key>
supabase functions deploy ai-proxy --no-verify-jwt
```

`scripts/edge-functions.manifest` lists every function and whether it verifies the JWT at the gateway. Deploy the others the same way when you need them. Email functions need `RESEND_API_KEY` and `FROM_EMAIL`. SMS functions need the Twilio values. The full list is at the bottom of `.env.example`.

### 3. Set environment variables

```bash
cp .env.example .env.local
```

Fill in at least these four:

| Variable | What it is |
|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Your Supabase anon key. It is public and gated by row level security. |
| `EXPO_PUBLIC_AI_PROXY_URL` | `https://<your-project-ref>.supabase.co/functions/v1/ai-proxy` |
| `EXPO_PUBLIC_AI_PROXY_TOKEN` | The same value you set as `AI_PROXY_APP_TOKEN` |

Everything else is optional. RevenueCat, PostHog, Sentry, Google Sign-In, and calendar sync turn off cleanly when their keys are empty. `app.config.js` reads these values and fills in `app.json` at build time, so no keys live in the repo.

### 4. Start

```bash
npx expo run:ios        # builds and opens in the simulator
# or
npx expo start          # if you already have a development build installed
```

### 5. Checks

```bash
npm run typecheck
npm test
npm run lint
```

CI runs the same checks on every pull request.

## Ship your own build

The bundle ID in `app.json` is `com.jhuff.nexus`, which belongs to the official app. Set `IOS_BUNDLE_ID` to your own, and update the app group (`group.com.jhuff.nexus`) and widget bundle ID in `app.json`, `plugins/withNexusWidget.js`, and the `.entitlements` files to match. Then run `eas init`, put the project ID in `EAS_PROJECT_ID`, and build with the `widgets` profile, which is the one that includes the widget:

```bash
eas build --platform ios --profile widgets
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). The short version: open an issue first for anything big, keep pull requests small, and make sure the checks pass.

## License

MIT. See [LICENSE](LICENSE).

NOTICE: The "Nexus" name and logo are not covered by the MIT license. You can use, change, and ship the code, but please give your build its own name and icon.
