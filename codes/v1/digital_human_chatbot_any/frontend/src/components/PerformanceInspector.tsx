import type { ServerEvent } from '@digital-human/shared';
import type { PoseActionEvent } from '../performance/events';
import { useState } from 'react';

export type PerformanceRow = Extract<ServerEvent, { type: 'performance.phrase' }> & {
  playback: string;
};
export type ActionRow = PoseActionEvent & { id: number };

export function PerformanceInspector({
  phrases,
  actions,
  backendCompatible,
}: {
  phrases: PerformanceRow[];
  actions: ActionRow[];
  backendCompatible?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const gestures = (value: PerformanceRow['selected']) =>
    value.gestures.map((gesture) => `${gesture.name} (${gesture.strength})`).join(', ') || 'none';
  return (
    <details
      className="performance-inspector"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        Performance inspector · 動作檢查
        {backendCompatible === false ? ' — backend restart required' : ''}
      </summary>
      {open && (
        <>
          {backendCompatible === false && (
            <p role="alert" className="settings-hint">
              The connected backend has not loaded the reaction controls. Restart the backend, then
              reload this page. Restarting clears its in-memory conversations; refreshing the
              browser alone does not update a running Node server.
            </p>
          )}
          <p className="settings-hint">
            Recent phrase controls and avatar action events, kept in this tab only. Text-only
            replies do not animate; Live2D supports only its listed gestures.
          </p>
          {!phrases.length ? (
            <p>No phrase controls received yet.</p>
          ) : (
            <div className="performance-table">
              <table>
                <thead>
                  <tr>
                    <th>Phrase</th>
                    <th>Emotion</th>
                    <th>Model selected</th>
                    <th>Applied</th>
                    <th>Decision / playback</th>
                  </tr>
                </thead>
                <tbody>
                  {phrases.map((row) => (
                    <tr key={`${row.turnId}:${row.phraseIndex}`}>
                      <td>{row.text}</td>
                      <td>{row.selected.emotion}</td>
                      <td>
                        {row.selected.reaction && (
                          <div>
                            {row.selected.reaction.name} ({row.selected.reaction.intensity})
                          </div>
                        )}
                        {gestures(row.selected)}
                      </td>
                      <td>{gestures(row.applied)}</td>
                      <td>
                        {row.decision} · {row.playback}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ul>
            {actions.map((event) => (
              <li key={event.id}>
                {event.action}: {event.status}
                {event.reason ? ` — ${event.reason}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
