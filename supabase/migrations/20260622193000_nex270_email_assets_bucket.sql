-- NEX-270: public Storage bucket for transactional-email assets (the weekly-summary cosmic
-- background, hosted at email-assets/weekly/cosmic-bg-v1.jpg and referenced by
-- supabase/functions/_shared/weekly-summary-email.ts).
--
-- Public buckets are world-readable through /storage/v1/object/public/<bucket>/<path> with no
-- RLS policy, which is exactly what an email background needs (recipients are unauthenticated).
-- Writes (upload/delete) still require service-role/owner access, so this is read-only to the world.
--
-- `on conflict do update set public = true` CONVERGES the bucket: if `email-assets` already exists
-- but is private, the unauthenticated /object/public/ URL would 403 and every email would lose its
-- background — so we force it public, which is the bucket's sole purpose. Idempotent + re-runnable.
insert into storage.buckets (id, name, public)
values ('email-assets', 'email-assets', true)
on conflict (id) do update set public = true;

-- NOTE — object seeding is NOT done here: a SQL migration cannot upload image bytes (they live in
-- object storage, not Postgres). The object must be uploaded once per environment from the repo's
-- source of record (assets/email/cosmic-bg-v1.jpg):
--   supabase storage cp ./assets/email/cosmic-bg-v1.jpg ss:///email-assets/weekly/cosmic-bg-v1.jpg
-- Already uploaded and verified (HTTP 200) in prod — the only environment that sends weekly emails
-- via Resend. If the object is ever missing, the email degrades gracefully to the solid #06060C
-- cosmic floor (see weekly-summary-email.ts), so a missing object never breaks delivery.
