/**
 * Placeholder for the three-screen rebuild. The dashboard, labels, automation and
 * connections screens have been removed; /sorted, /approve and /activity replace them.
 * This keeps the authenticated area reachable so signing in does not dead-end.
 */
export function SortedPage() {
  return (
    <div className="placeholder-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">Sorted</span>
          <h1>This screen is being rebuilt</h1>
          <p>
            The previous dashboard, labels, automation and connections screens have been removed.
            Your Gmail connection, synchronized mail and approved labels are untouched on the server
            — nothing was deleted from your account.
          </p>
        </div>
      </header>
    </div>
  );
}
