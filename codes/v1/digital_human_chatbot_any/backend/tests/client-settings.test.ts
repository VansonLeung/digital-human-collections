import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultClientSettings } from '@digital-human/shared';
import {
  loadSettings,
  saveSettings,
  settingsStorageKey,
} from '../../frontend/src/settings/storage.js';

function storage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

test('client preferences retain toggles and parameters without conversation or credentials', () => {
  const store = storage();
  const values = {
    ...defaultClientSettings,
    autoReplyEnabled: true,
    localizedProfanity: true,
    getToKnowEachOther: true,
    virtualScenesEnabled: true,
    autoEnterScenes: true,
    autoRecoverStalls: false,
    naturalVariation: false,
    aboutMe: 'I like quiet walks.\nI prefer tea.',
    autoReplyMode: 'spoken' as const,
    manualMessageMode: 'spoken' as const,
    autoReplyDelaySeconds: 2,
    autoReplyMaxTurns: 7,
    displayMode: 'phrases' as const,
    muted: true,
    language: 'yue' as const,
    idleSeconds: 90,
    poseStrength: 0.75,
    poseHoldSeconds: 4,
  };
  saveSettings(store, values);
  assert.deepEqual(loadSettings(store).values, values);
  assert.equal(JSON.parse(store.getItem(settingsStorageKey)!).version, 1);
  assert.ok(!store.getItem(settingsStorageKey)!.includes('history'));
  assert.ok(!store.getItem(settingsStorageKey)!.includes('API_KEY'));
});

test('malformed preferences fall back per field and unsupported versions reset to defaults', () => {
  const store = storage();
  store.setItem(
    settingsStorageKey,
    JSON.stringify({
      version: 1,
      values: {
        idleSeconds: -1,
        speech: false,
        autoReplyMaxTurns: 999,
        displayMode: 'unknown',
        language: 'yue',
        localizedProfanity: 'true',
        getToKnowEachOther: 'true',
        aboutMe: 'x'.repeat(2001),
      },
    }),
  );
  const restored = loadSettings(store);
  assert.equal(restored.values.idleSeconds, 60);
  assert.equal(restored.values.autoReplyMaxTurns, 5);
  assert.equal(restored.values.displayMode, 'full');
  assert.equal(restored.values.speech, false);
  assert.equal(restored.values.localizedProfanity, false);
  assert.equal(restored.values.getToKnowEachOther, false);
  assert.equal(restored.values.aboutMe, '');
  assert.equal(restored.values.language, 'yue');
  store.setItem(settingsStorageKey, '{broken');
  assert.deepEqual(loadSettings(store).values, defaultClientSettings);
  store.setItem(settingsStorageKey, JSON.stringify({ version: 2, values: { speech: false } }));
  assert.deepEqual(loadSettings(store).values, defaultClientSettings);
});

test('blocked browser storage leaves settings usable in memory', () => {
  const store = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {},
  };
  assert.deepEqual(loadSettings(store).values, defaultClientSettings);
  assert.doesNotThrow(() => saveSettings(store, defaultClientSettings));
});
