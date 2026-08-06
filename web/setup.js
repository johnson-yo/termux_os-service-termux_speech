/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: setup.html, Framework Browser Session, and instance-scoped Wake Words/KWS routes.
 * [OUTPUT]: Profile enrollment, build, active selection, one-shot test, and live stream-test interactions.
 * [POS]: Browser presentation migrated from Wake Words 0.5.0; it handles pinyin text metadata, never credentials or PCM.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
const pathPackageId = decodeURIComponent(location.pathname.split('/')[2] ?? '');
const ACTIVE_PACKAGE_ID = /^[\w.@-]+$/.test(pathPackageId)
  ? pathPackageId
  : 'github.termux-os.service.termux-speech';
const ROOT = `/api/packages/${ACTIVE_PACKAGE_ID}`;
const WAKE = `${ROOT}/wake-words`;
const $ = (id) => document.getElementById(id);

let current = null;
let activeProfileId = null;
let positiveTarget = 6;
let recordGeneration = 0;
let lastTest = null;
let streamTimer = null;

const requestAt = async (base, path, { method = 'GET', body } = {}) => {
  const response = await window.TermuxOS.api(base + path, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error ?? `HTTP ${response.status}`);
  }
  return payload;
};
const wakeApi = (path, options) => requestAt(WAKE, path, options);
const audioApi = (path, options) => requestAt(ROOT, path, options);

const banner = (message, warn = true) => {
  const element = $('banner');
  element.hidden = !message;
  element.textContent = message ?? '';
  element.classList.toggle('warn', Boolean(message) && warn);
  element.classList.toggle('ok', Boolean(message) && !warn);
};

const smallText = (text, className = '') => {
  const element = document.createElement('div');
  element.className = `tiny ${className}`.trim();
  element.textContent = text;
  return element;
};

async function loadProfiles(selectId = null) {
  const payload = await wakeApi('/profiles');
  activeProfileId = payload.config?.active_profile_id ?? null;
  positiveTarget = Number(payload.config?.positive_target) || 6;
  if (payload.config?.score_threshold) {
    $('thresh').value = String(payload.config.score_threshold);
    $('thresh-val').textContent = Number(payload.config.score_threshold).toFixed(2);
  }
  const picker = $('profile-picker');
  const options = [new Option('—', '')];
  for (const profile of payload.profiles) {
    const active = profile.profile_id === activeProfileId ? ' · 当前' : '';
    options.push(new Option(
      `${profile.display_name} (${profile.sample_count})${active}`,
      profile.profile_id,
    ));
  }
  picker.replaceChildren(...options);
  const target = selectId ?? activeProfileId;
  if (target) picker.value = target;
  return { ...payload, selected: target };
}

async function openProfile(id) {
  if (!id) {
    current = null;
    $('view-record').hidden = true;
    return;
  }
  const { profile } = await wakeApi(`/profile?id=${encodeURIComponent(id)}`);
  current = profile;
  $('view-record').hidden = false;
  $('active-name').textContent = profile.display_name;
  $('phrase-cue').textContent = profile.display_name;
  renderSamples();
  renderModel();
  renderActiveButton();
}

function renderActiveButton() {
  const active = current?.profile_id === activeProfileId;
  const built = (current?.model?.templates?.length || current?.model?.kept?.length || 0) > 0;
  $('select-active').textContent = active ? '当前 Keyword' : '设为当前';
  $('select-active').disabled = active || !built;
  $('select-active').classList.toggle('selected', active);
}

function renderModel() {
  const element = $('model-summary');
  const model = current?.model;
  element.hidden = false;
  element.className = 'model-summary';
  element.replaceChildren();
  if (!model) {
    element.classList.add('warn');
    element.append(smallText('录好后点「生成 / 更新匹配」。'));
    return;
  }
  const kept = model.templates || model.kept || [];
  const representative = model.representative?.text || model.representative || null;
  const others = kept.map((item) => item.text).filter((text) => text && text !== representative);
  if (representative) element.append(smallText(`核心发音：${representative}`));
  if (others.length) element.append(smallText(`附加说法：${others.join(' / ')}`));
  const tooShort = model.syllables != null && model.syllables < 2;
  const weak = (model.consistency != null && model.consistency < 0.45)
    || (model.empty ?? 0) * 3 >= (current.samples.length || 1);
  element.append(smallText(
    tooShort
      ? '⚠ 这个词太短，容易误触。建议换成两三个字以上。'
      : weak
        ? '⚠ 几遍录音差别较大，建议说清楚重录。'
        : '✓ 可以使用；它已可设为 Audio 当前 Keyword。',
    tooShort || weak ? 'warn-text' : 'good-text',
  ));
  if (model.empty) element.append(smallText(`有 ${model.empty} 遍没听清，已忽略。`));
}

async function buildModel() {
  if (!current) return;
  banner(null);
  $('build-btn').disabled = true;
  $('build-btn').textContent = '生成中…';
  try {
    const payload = await wakeApi('/profile/build', {
      method: 'POST',
      body: { profile_id: current.profile_id },
    });
    current.model = payload.model;
    activeProfileId = payload.active_profile_id;
    renderModel();
    renderActiveButton();
    await loadProfiles(current.profile_id);
    banner(`「${current.display_name}」已生成并设为当前 Keyword。`, false);
  } catch (error) {
    banner(error.message);
  } finally {
    $('build-btn').disabled = false;
    $('build-btn').textContent = '生成 / 更新匹配';
  }
}

function renderSamples() {
  const count = current.samples.length;
  $('sample-count').textContent = count < positiveTarget
    ? `已录 ${count} 遍（建议 ${positiveTarget}+）`
    : `已录 ${count} 遍`;
  $('cue-kind').textContent = `第 ${count + 1} 遍`;
  const list = $('sample-list');
  list.replaceChildren();
  if (!count) {
    list.append(smallText('还没有录音', 'hint'));
    return;
  }
  current.samples.forEach((sample, index) => {
    const row = document.createElement('div');
    row.className = 'sample-item';
    const number = document.createElement('b');
    number.textContent = String(index + 1);
    const heard = document.createElement('span');
    heard.textContent = `听到：${sample.bpe?.text || '（没听清）'}`;
    const remove = document.createElement('button');
    remove.className = 'ghost';
    remove.textContent = '✕';
    remove.addEventListener('click', async () => {
      try {
        const payload = await wakeApi('/samples/delete', {
          method: 'POST',
          body: {
            profile_id: current.profile_id,
            sample_id: sample.sample_id,
          },
        });
        current = payload.profile;
        renderSamples();
        renderModel();
        renderActiveButton();
        await loadProfiles(current.profile_id);
      } catch (error) {
        banner(error.message);
      }
    });
    row.append(number, heard, remove);
    list.append(row);
  });
}

const setRecording = (active) => {
  $('record-btn').hidden = active;
  $('stop-btn').hidden = !active;
};

async function startRecord() {
  if (!current) return;
  banner(null);
  setRecording(true);
  const generation = ++recordGeneration;
  try {
    await wakeApi('/guided/capture/start', {
      method: 'POST',
      body: {
        profile_id: current.profile_id,
        index: current.samples.length,
      },
    });
    void pollRecord(generation);
  } catch (error) {
    if (generation === recordGeneration) {
      setRecording(false);
      banner(error.message);
    }
  }
}

async function pollRecord(generation) {
  if (generation !== recordGeneration) return;
  let capture;
  try {
    ({ capture } = await wakeApi('/guided/capture/poll', {
      method: 'POST',
      body: {},
    }));
  } catch (error) {
    if (generation === recordGeneration) {
      recordGeneration += 1;
      setRecording(false);
      banner(error.message);
    }
    return;
  }
  if (generation !== recordGeneration) return;
  if (!capture.finalized) {
    $('record-note').textContent = capture.heard
      ? '听到了，说完停顿后自动结束…'
      : capture.connected ? '请说…' : '正在连接 HTP KWS…';
    setTimeout(() => void pollRecord(generation), 300);
    return;
  }
  recordGeneration += 1;
  setRecording(false);
  if (capture.saved && capture.sample) {
    $('record-note').textContent = `已解码：${capture.sample.bpe?.text || '（空）'}`;
    await openProfile(current.profile_id);
    await loadProfiles(current.profile_id);
    return;
  }
  banner(`未保存：${capture.error || '没有听到拼音 token'}`);
}

async function stopRecord() {
  try {
    await wakeApi('/guided/capture/stop', { method: 'POST', body: {} });
  } catch (error) {
    banner(error.message);
  }
}

function renderTest() {
  const element = $('test-result');
  if (!lastTest) {
    element.hidden = true;
    return;
  }
  element.hidden = false;
  element.replaceChildren();
  if (lastTest.built === false) {
    element.className = 'test-result miss';
    element.append(smallText('还没生成匹配，请先生成。'));
    return;
  }
  const threshold = Number($('thresh').value);
  const score = Number(lastTest.score) || 0;
  const hit = score >= threshold;
  element.className = `test-result ${hit ? 'hit' : 'miss'}`;
  const scoreLine = document.createElement('strong');
  scoreLine.className = 'score-big';
  scoreLine.textContent = `${score.toFixed(2)} · ${hit ? '✓ 命中' : '✗ 未命中'}`;
  element.append(
    scoreLine,
    smallText(`解码：${lastTest.decoded_text || '（空）'}`),
  );
  if (lastTest.best) {
    element.append(smallText(`最接近：${lastTest.best.text || '已登记发音'}`));
  }
}

const setTesting = (active) => {
  $('test-btn').hidden = active;
  $('test-stop').hidden = !active;
};

async function startTest() {
  if (!current) return;
  banner(null);
  setTesting(true);
  lastTest = null;
  renderTest();
  const generation = ++recordGeneration;
  try {
    await wakeApi('/guided/test/start', {
      method: 'POST',
      body: {
        profile_id: current.profile_id,
        threshold: Number($('thresh').value),
      },
    });
    void pollTest(generation);
  } catch (error) {
    if (generation === recordGeneration) {
      setTesting(false);
      banner(error.message);
    }
  }
}

async function pollTest(generation) {
  if (generation !== recordGeneration) return;
  let capture;
  try {
    ({ capture } = await wakeApi('/guided/capture/poll', {
      method: 'POST',
      body: {},
    }));
  } catch (error) {
    if (generation === recordGeneration) {
      recordGeneration += 1;
      setTesting(false);
      banner(error.message);
    }
    return;
  }
  if (!capture.finalized) {
    $('test-note').textContent = capture.heard ? '听到了…' : '请说…';
    setTimeout(() => void pollTest(generation), 300);
    return;
  }
  recordGeneration += 1;
  setTesting(false);
  if (capture.test) {
    $('test-note').textContent = '完成';
    lastTest = capture.test;
    renderTest();
  } else {
    $('test-note').textContent = capture.error || '无结果';
  }
}

async function stopTest() {
  try {
    await wakeApi('/guided/capture/stop', { method: 'POST', body: {} });
  } catch (error) {
    banner(error.message);
  }
}

function renderStream(stream) {
  const threshold = stream.threshold ?? Number($('thresh').value);
  const score = Number(stream.score) || 0;
  $('meter-fill').style.width = `${Math.round(Math.min(1, Math.max(0, score)) * 100)}%`;
  $('meter-fill').className = `meter-fill ${score >= threshold ? 'hit' : ''}`.trim();
  $('meter-thr').style.left = `${Math.round(threshold * 100)}%`;
  $('stream-score').textContent = score.toFixed(2);
  $('stream-count').textContent = String(stream.count ?? 0);
  $('stream-state').textContent = !stream.running
    ? '已停止'
    : stream.speaking ? '🎙 说话中'
      : stream.feed_connected ? '👂 监听中'
        : '连接 KWS…';
  $('stream-note').textContent = !stream.running
    ? '已停止'
    : stream.last_hit
      ? `✓ 最近命中 ${Number(stream.last_hit.score).toFixed(2)}：${stream.decoded_text || ''}`
      : `边说边看匹配条上升${stream.last_error ? ` · ${stream.last_error}` : ''}`;
}

const streamUi = (active) => {
  $('stream-btn').hidden = active;
  $('stream-stop').hidden = !active;
};

async function pollStream() {
  try {
    const { stream } = await wakeApi('/guided/stream-test/status');
    renderStream(stream);
    if (!stream.running) {
      clearInterval(streamTimer);
      streamTimer = null;
      streamUi(false);
    }
  } catch { /* A later poll can recover. */ }
}

async function startStream() {
  if (!current) return;
  banner(null);
  streamUi(true);
  try {
    const { stream } = await wakeApi('/guided/stream-test/start', {
      method: 'POST',
      body: {
        profile_id: current.profile_id,
        threshold: Number($('thresh').value),
      },
    });
    renderStream(stream);
    clearInterval(streamTimer);
    streamTimer = setInterval(() => void pollStream(), 300);
  } catch (error) {
    banner(error.message);
    streamUi(false);
  }
}

async function stopStream() {
  clearInterval(streamTimer);
  streamTimer = null;
  streamUi(false);
  try {
    const { stream } = await wakeApi('/guided/stream-test/stop', {
      method: 'POST',
      body: {},
    });
    renderStream(stream);
  } catch (error) {
    banner(error.message);
  }
}

async function refreshPill() {
  try {
    const { value } = await audioApi('/kws');
    $('service-pill').textContent = value.provider?.connected ? '●' : '▲';
    $('service-pill').classList.toggle('ok', value.provider?.connected === true);
    $('service-pill').title = `KWS：${value.state}${value.reason ? ` · ${value.reason}` : ''}`;
  } catch {
    $('service-pill').textContent = '·';
  }
}

async function initialize() {
  $('create-profile').addEventListener('click', async () => {
    const displayName = $('display-name').value.trim();
    try {
      const { profile } = await wakeApi('/profiles', {
        method: 'POST',
        body: { display_name: displayName },
      });
      $('display-name').value = '';
      await loadProfiles(profile.profile_id);
      await openProfile(profile.profile_id);
    } catch (error) {
      banner(error.message);
    }
  });
  $('profile-picker').addEventListener('change', (event) => void openProfile(event.target.value));
  $('delete-profile').addEventListener('click', async () => {
    if (!current || !confirm(`删除「${current.display_name}」及其全部样本？`)) return;
    try {
      await wakeApi('/profile/delete', {
        method: 'POST',
        body: { profile_id: current.profile_id },
      });
      current = null;
      $('view-record').hidden = true;
      await loadProfiles();
    } catch (error) {
      banner(error.message);
    }
  });
  $('select-active').addEventListener('click', async () => {
    if (!current) return;
    try {
      await audioApi('/kws/config', {
        method: 'POST',
        body: { active_profile_id: current.profile_id },
      });
      activeProfileId = current.profile_id;
      renderActiveButton();
      await loadProfiles(current.profile_id);
      banner(`「${current.display_name}」已设为当前 Keyword。`, false);
    } catch (error) {
      banner(error.message);
    }
  });
  $('record-btn').addEventListener('click', startRecord);
  $('stop-btn').addEventListener('click', stopRecord);
  $('build-btn').addEventListener('click', buildModel);
  $('test-btn').addEventListener('click', startTest);
  $('test-stop').addEventListener('click', stopTest);
  $('stream-btn').addEventListener('click', startStream);
  $('stream-stop').addEventListener('click', stopStream);
  $('thresh').addEventListener('input', () => {
    $('thresh-val').textContent = Number($('thresh').value).toFixed(2);
    renderTest();
  });

  await refreshPill();
  try {
    const profiles = await loadProfiles();
    if (profiles.selected) await openProfile(profiles.selected);
  } catch (error) {
    banner(error.message);
  }
  setInterval(() => void refreshPill(), 3000);
}

window.TermuxOS.ready.then(initialize);
