import { useEffect, useState } from 'react';
import type { ConversationMemory, SceneSnapshot } from '@digital-human/shared';

function MemoryRow({
  memory,
  disabled,
  onEdit,
  onForget,
}: {
  memory: ConversationMemory;
  disabled: boolean;
  onEdit: (id: string, value: string) => void;
  onForget: (id: string) => void;
}) {
  const [value, setValue] = useState(memory.value);
  useEffect(() => setValue(memory.value), [memory.value]);
  return (
    <div className="memory-row">
      <label>
        {memory.owner === 'user' ? 'You · confirmed input' : 'Mira · fictional character'} ·{' '}
        {memory.category}
        <textarea
          aria-label={`Memory: ${memory.key}`}
          value={value}
          maxLength={240}
          rows={2}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <small>
        Source: “{memory.quote}”{memory.source === 'manual_edit' ? ' · edited by you' : ''}
      </small>
      <div className="scene-actions">
        <button
          type="button"
          disabled={disabled || !value.trim() || value === memory.value}
          onClick={() => onEdit(memory.id, value)}
        >
          Save memory
        </button>
        <button type="button" disabled={disabled} onClick={() => onForget(memory.id)}>
          Forget memory
        </button>
      </div>
    </div>
  );
}

export function ConversationMemoryControls(props: {
  memories: ConversationMemory[];
  sceneHistory?: SceneSnapshot['history'];
  disabled: boolean;
  onEdit: (id: string, value: string) => void;
  onForget: (id: string) => void;
}) {
  return (
    <details className="conversation-memory">
      <summary>Conversation memory · 本次對話記憶 ({props.memories.length})</summary>
      <p className="settings-hint">
        Only for this conversation; Clear conversation and a page reload clear it. Automatic male
        dialogue never establishes facts about you. Mira’s preferences are fictional. Edits pause
        auto replies.
      </p>
      {!props.memories.length && (
        <p className="settings-hint">New, supported details will appear here as you talk.</p>
      )}
      {props.memories.map((memory) => (
        <MemoryRow
          key={memory.id}
          memory={memory}
          disabled={props.disabled}
          onEdit={props.onEdit}
          onForget={props.onForget}
        />
      ))}
      {!!props.sceneHistory?.length && (
        <div className="memory-history">
          <strong>Earlier virtual outings · 虛構共同經歷</strong>
          {props.sceneHistory.map((scene, index) => (
            <small key={index}>
              {scene.title} · {scene.location} · {scene.activity}
            </small>
          ))}
          <small>
            Only places actually reached are retained; these are not real-user biography.
          </small>
        </div>
      )}
    </details>
  );
}
