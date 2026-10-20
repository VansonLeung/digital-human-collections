export function TypingIndicator({ label }: { label: string }) {
  return (
    <span className="thinking" role="status" aria-label={label}>
      <i aria-hidden="true" />
      <i aria-hidden="true" />
      <i aria-hidden="true" />
    </span>
  );
}
