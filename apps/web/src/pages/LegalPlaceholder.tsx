export function LegalPlaceholder({ title }: { title: string }) {
  return (
    <main className="legal-page">
      <span className="eyebrow">MailMind AI</span>
      <h1>{title}</h1>
      <p>This document will be published before public release.</p>
      <a href="/">Return home</a>
    </main>
  );
}
