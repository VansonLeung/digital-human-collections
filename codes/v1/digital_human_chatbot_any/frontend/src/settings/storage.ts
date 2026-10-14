import {
  clientSettingsSchema,
  defaultClientSettings,
  type ClientSettings,
} from '@digital-human/shared';

export const settingsStorageKey = 'persona-studio.settings.v1';
type SettingsStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function loadSettings(storage: SettingsStorage) {
  const saved: Partial<ClientSettings> = {};
  try {
    const record = JSON.parse(storage.getItem(settingsStorageKey) ?? 'null');
    if (record?.version !== 1 || !record.values || typeof record.values !== 'object')
      return { values: { ...defaultClientSettings }, saved };
    // A malformed field cannot erase unrelated valid preferences.
    for (const key of Object.keys(clientSettingsSchema.shape) as (keyof ClientSettings)[]) {
      if (!(key in record.values)) continue;
      const value = clientSettingsSchema.shape[key].safeParse(record.values[key]);
      if (value.success) Object.assign(saved, { [key]: value.data });
    }
  } catch {
    /* Storage can be blocked or contain invalid JSON. */
  }
  return { values: { ...defaultClientSettings, ...saved }, saved };
}

export function saveSettings(storage: SettingsStorage, values: ClientSettings) {
  try {
    storage.setItem(
      settingsStorageKey,
      JSON.stringify({ version: 1, values: clientSettingsSchema.parse(values) }),
    );
  } catch {
    /* Preferences remain usable in memory when storage is unavailable. */
  }
}
