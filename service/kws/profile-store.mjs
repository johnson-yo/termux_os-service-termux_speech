/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Package-private data root and pinyin token segments emitted by the App provider.
 * [OUTPUT]: Atomic wake profile/sample CRUD and built-model persistence.
 * [POS]: KWS durable truth source migrated from Wake Words 0.5.0; it stores no PCM or WAV.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const issue = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  throw error;
};
const profilesDir = (root) => path.join(root, 'profiles');
const profileDir = (root, id) => path.join(profilesDir(root), id);
const profileFile = (root, id) => path.join(profileDir(root, id), 'profile.json');

const atomicJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
};

const tokensToKeyword = (tokens) => (tokens ?? [])
  .map((token) => String(token).trim())
  .filter(Boolean)
  .join(' ');

export function listProfiles(dataRoot) {
  const directory = profilesDir(dataRoot);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((id) => fs.existsSync(profileFile(dataRoot, id)))
    .map((id) => {
      const profile = JSON.parse(fs.readFileSync(profileFile(dataRoot, id), 'utf8'));
      return {
        profile_id: profile.profile_id,
        display_name: profile.display_name,
        sample_count: profile.samples.length,
        built: Boolean(profile.model?.templates?.length),
        threshold: profile.model?.threshold ?? null,
        created_at: profile.created_at,
      };
    })
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

export function getProfile(dataRoot, id) {
  if (typeof id !== 'string' || !id) issue('profile id is required');
  const file = profileFile(dataRoot, id);
  if (!fs.existsSync(file)) issue(`profile not found: ${id}`, 404);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function createProfile(dataRoot, displayName) {
  const name = typeof displayName === 'string' && displayName.trim()
    ? displayName.trim().slice(0, 80)
    : 'wake word';
  const profile = {
    schema: 'termux-os.wake-words.profile.v1',
    profile_id: `wp_${crypto.randomBytes(8).toString('hex')}`,
    display_name: name,
    created_at: new Date().toISOString(),
    samples: [],
  };
  atomicJson(profileFile(dataRoot, profile.profile_id), profile);
  return profile;
}

export function deleteProfile(dataRoot, id) {
  getProfile(dataRoot, id);
  fs.rmSync(profileDir(dataRoot, id), { recursive: true, force: true });
  return { profile_id: id };
}

export function saveSamplePinyin(dataRoot, id, index, {
  text,
  tokens,
  provider = 'termux-os.app.api',
}) {
  const profile = getProfile(dataRoot, id);
  const sampleId = `s_${crypto.randomBytes(6).toString('hex')}`;
  const sample = {
    sample_id: sampleId,
    index: Number.isInteger(index) ? index : profile.samples.length,
    recorded_at: new Date().toISOString(),
    source: 'termux-os.pinyin-stream.v1',
    bpe: {
      text,
      tokens,
      provider,
      encoder: 'model.wake-pinyin.app-htp',
    },
    keyword: tokensToKeyword(tokens),
  };
  profile.samples.push(sample);
  profile.samples.sort((a, b) => a.index - b.index);
  atomicJson(profileFile(dataRoot, id), profile);
  return { profile, sample };
}

export function setProfileModel(dataRoot, id, model) {
  const profile = getProfile(dataRoot, id);
  profile.model = model;
  atomicJson(profileFile(dataRoot, id), profile);
  return profile;
}

export function deleteSample(dataRoot, id, sampleId) {
  const profile = getProfile(dataRoot, id);
  const before = profile.samples.length;
  profile.samples = profile.samples.filter((sample) => sample.sample_id !== sampleId);
  if (profile.samples.length === before) issue(`sample not found: ${sampleId}`, 404);
  atomicJson(profileFile(dataRoot, id), profile);
  return { profile };
}
