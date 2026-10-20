-- Deliver row-change notifications under the existing owner-only SELECT RLS.
-- No user data, grants, policies, or objects in the managed realtime schema change.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'user_state'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_state;
  END IF;
END;
$$;
