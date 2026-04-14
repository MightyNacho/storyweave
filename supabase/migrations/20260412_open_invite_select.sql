-- Allow authenticated users to read stories with an active invite link.
-- This is required so link recipients can SELECT the story before joining.
-- The UPDATE policy stays restricted; joining is handled server-side via /api/join.

DROP POLICY IF EXISTS "stories_select" ON stories;

CREATE POLICY "stories_select" ON stories
FOR SELECT TO authenticated USING (
  creator_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(participants) AS p
    WHERE p->>'email' = auth.email()
  )
  OR (open_invite_expires_at IS NOT NULL AND open_invite_expires_at > NOW())
);
