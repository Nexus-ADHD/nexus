# Contributing to Nexus

Thanks for helping build this.

## Before you start

- For anything bigger than a small fix, open an issue first and say what you want to change and why. It saves both of us time.
- Check the open issues. If one fits, comment on it so people know you are on it.

## Making a change

1. Fork the repo and make a branch off `main`.
2. Follow the setup in the README.
3. Keep the pull request small and about one thing.
4. Run the checks before you push:

   ```bash
   npm run typecheck
   npm test
   npm run lint
   ```

5. Open the pull request. Say what changed, why, and how you tested it. Add a screenshot or short recording for anything you can see.

## House rules

- No model provider keys in the app. Every AI call goes through the `ai-proxy` edge function.
- No secrets in the repo. Use `.env.local` and Supabase secrets.
- Anything that writes to a user's calendar, goals, or habits shows a review card first.
- Do not call native APIs at module scope. Do it in an effect or an event handler.
- Use the design tokens in `src/theme/tokens.ts`, not raw colors or sizes.
- New `// @ts-nocheck` lines fail CI. Fix the types instead.

## Reporting a security issue

Do not open a public issue. Email TODO-security-contact and give us time to fix it before you share it.

## License

By contributing, you agree that your work is released under the MIT license in this repo.
