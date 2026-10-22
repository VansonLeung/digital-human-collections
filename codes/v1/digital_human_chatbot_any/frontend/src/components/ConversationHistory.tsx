import type { ConversationSummary } from '@digital-human/shared';

type Props = {
  items: ConversationSummary[];
  current?: ConversationSummary;
  error: string;
  loading: boolean;
  saving: boolean;
  connected: boolean;
  disabled: boolean;
  sessionId: string;
  canSave: boolean;
  available: boolean;
  onOpen: (id?: string) => void;
  onSave: () => void;
  onRefresh: () => void;
};

export function ConversationHistory(props: Props) {
  return (
    <details
      className="conversation-history"
      onToggle={(event) => {
        if (event.currentTarget.open) props.onRefresh();
      }}
    >
      <summary>Saved conversations · 對話記錄</summary>
      <p className="settings-hint" role="status">
        {props.loading
          ? 'Loading conversation…'
          : props.current
            ? `Saved · ${props.current.title}`
            : 'Completed exchanges are saved automatically on this machine.'}
      </p>
      {!props.available && (
        <p className="settings-hint">Restart the backend to load saved-conversation support.</p>
      )}
      {props.error && <p role="alert">{props.error}</p>}
      <div className="history-actions">
        <button
          type="button"
          disabled={props.disabled || props.loading}
          onClick={() => props.onOpen()}
        >
          New conversation
        </button>
        <button
          type="button"
          disabled={
            !props.connected || props.disabled || props.saving || !props.canSave || !props.available
          }
          onClick={props.onSave}
        >
          {props.saving ? 'Saving…' : 'Save now'}
        </button>
        {props.connected && (
          <a href={`/api/sessions/${props.sessionId}/conversation`} download>
            Export JSON
          </a>
        )}
      </div>
      {props.current && (
        <label className="history-url">
          Conversation URL
          <input
            aria-label="Conversation URL"
            readOnly
            value={`${location.origin}/conversations/${props.current.id}`}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      )}
      {!props.items.length ? (
        <p className="settings-hint">No saved conversations yet.</p>
      ) : (
        <ul className="history-list">
          {props.items.map((item) => (
            <li key={item.id}>
              <a
                href={`/conversations/${item.id}`}
                aria-current={item.id === props.current?.id ? 'page' : undefined}
                onClick={(event) => {
                  if (
                    event.button ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  if (!props.disabled && !props.loading) props.onOpen(item.id);
                }}
              >
                {item.title}
              </a>
              <span>
                {item.messageCount} bubbles · {new Date(item.updatedAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
