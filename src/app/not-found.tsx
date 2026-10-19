export const metadata = { title: 'Nicht gefunden · Starship' };

/**
 * #1224 AK5: without this file, Next falls back to an internal default that a
 * route calling `notFound()` mid-render (e.g. `/admin` for a non-admin
 * account) renders differently from a URL the router never matched at all —
 * confirmed by e2e, the two bodies differed by several KB. A `not-found.tsx`
 * gives both cases the exact same boundary, so a non-admin account cannot
 * tell "/admin exists but isn't for you" apart from "this page doesn't exist".
 * Deliberately static — no session read, nothing that could make the two
 * cases diverge again.
 */
export default function NotFound() {
  return (
    <main className="auth">
      <h1>Seite nicht gefunden</h1>
    </main>
  );
}
