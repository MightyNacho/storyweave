import { createBrowserClient } from "@supabase/ssr";

// Lazy singleton — defers createBrowserClient until first use so
// Next.js can evaluate this module at build time without crashing.
let _client;
const getClient = () => {
  if (!_client) {
    _client = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    );
  }
  return _client;
};

export const supabase = new Proxy(
  {},
  { get(_, prop) { return getClient()[prop]; } }
);
