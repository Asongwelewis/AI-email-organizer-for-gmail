export function RouteLoader({ label = 'Checking your session' }: { label?: string }) {
  return (
    <div className="route-loader" role="status" aria-live="polite" aria-label={label}>
      <span className="route-loader__mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <p>{label}</p>
    </div>
  );
}
