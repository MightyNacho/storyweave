-- Enable Row Level Security on the stories table
ALTER TABLE stories ENABLE ROW LEVEL SECURITY;

-- SELECT: user is the creator OR their email appears in the participants array
-- This makes the dashboard automatically show all stories a user created or was invited to
-- Note: auth.email() is used instead of querying auth.users directly; the authenticated
-- role does not have SELECT permission on auth.users, which would silently break the policy.
CREATE POLICY "stories_select" ON stories
FOR SELECT TO authenticated USING (
  creator_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(participants) AS p
    WHERE p->>'email' = auth.email()
  )
);

-- INSERT: authenticated users can create stories (creator_id must match their uid)
CREATE POLICY "stories_insert" ON stories
FOR INSERT TO authenticated WITH CHECK (
  creator_id = auth.uid()
);

-- UPDATE: creator or any participant can update (participants add entries via full-story updates)
CREATE POLICY "stories_update" ON stories
FOR UPDATE TO authenticated USING (
  creator_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(participants) AS p
    WHERE p->>'email' = auth.email()
  )
);

-- DELETE: creator only
CREATE POLICY "stories_delete" ON stories
FOR DELETE TO authenticated USING (
  creator_id = auth.uid()
);
