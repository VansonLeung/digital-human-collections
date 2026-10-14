import type { ReplyDiagnostic } from '@digital-human/shared';

export function ReplyDiagnostics({ diagnostic }: { diagnostic: ReplyDiagnostic }) {
  return (
    <details className="reply-diagnostics">
      <summary>Inspect raw LLM response</summary>
      <p>
        Model: {diagnostic.model} · Finish reason: {diagnostic.finishReason ?? 'not reported'} ·{' '}
        {diagnostic.outputComplete ? 'Complete response' : 'Partial response'}
        {diagnostic.truncated ? ' (size limit reached)' : ''}
      </p>
      <label>
        Raw model output
        <textarea
          aria-label="Raw LLM response"
          readOnly
          value={diagnostic.rawOutput || '(empty response)'}
        />
      </label>
      <label>
        LLM request body
        <textarea
          aria-label="LLM request body"
          readOnly
          value={
            diagnostic.requestBody
              ? JSON.stringify(diagnostic.requestBody, null, 2)
              : '(request body was not captured for this diagnostic)'
          }
        />
      </label>
      <pre>{JSON.stringify({ reason: diagnostic.reason, parser: diagnostic.parser }, null, 2)}</pre>
      <div>
        {diagnostic.requestBody && (
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard.writeText(JSON.stringify(diagnostic.requestBody, null, 2))
            }
          >
            Copy request body
          </button>
        )}
        <button
          type="button"
          onClick={() => void navigator.clipboard.writeText(JSON.stringify(diagnostic, null, 2))}
        >
          Copy diagnostics
        </button>
        {diagnostic.downloadUrl && (
          <a href={diagnostic.downloadUrl} download>
            Download diagnostics
          </a>
        )}
      </div>
    </details>
  );
}
