import { useEffect, useState } from 'react';
import { defaultClientSettings, type ClientSettings } from '@digital-human/shared';
import { loadSettings, saveSettings, settingsStorageKey } from '../settings/storage';

export function useSettings() {
  const [initial] = useState(() => {
    try {
      return loadSettings(localStorage);
    } catch {
      return { values: { ...defaultClientSettings }, saved: {} };
    }
  });
  const [settings, setSettings] = useState<ClientSettings>(initial.values);
  useEffect(() => {
    try {
      saveSettings(localStorage, settings);
    } catch {
      /* In-memory fallback. */
    }
  }, [settings]);

  function update<K extends keyof ClientSettings>(key: K, value: ClientSettings[K]) {
    setSettings((previous) => ({ ...previous, [key]: value }));
  }
  function reset() {
    try {
      localStorage.removeItem(settingsStorageKey);
    } catch {
      /* In-memory fallback. */
    }
    setSettings({ ...defaultClientSettings });
  }
  return { settings, update, reset, saved: initial.saved };
}
