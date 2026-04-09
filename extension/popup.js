const SERVER       = 'http://localhost:7979';
const POLL_INTERVAL = 1500;
const STORAGE_KEY   = 'yt_downloads';
const WEB_STORAGE_KEY = 'web_downloads';

// ── State ──────────────────────────────────────────────────────────
let mode         = 'video';
let videoQuality = '1080';
let audioQuality = 'medium';
let serverOnline = false;
let appMode      = 'yt';   // 'yt' | 'web'
let webQuality   = 'best[height<=720]';

// ── DOM refs – YT ──────────────────────────────────────────────────
const urlInput       = document.getElementById('url-input');
const pasteBtn       = document.getElementById('paste-btn');
const urlError       = document.getElementById('url-error');
const statusDot      = document.getElementById('server-status');
const tabVideo       = document.getElementById('tab-video');
const tabAudio       = document.getElementById('tab-audio');
const videoOptions   = document.getElementById('video-options');
const audioOptions   = document.getElementById('audio-options');
const downloadBtn    = document.getElementById('download-btn');
const downloadList   = document.getElementById('download-list');
const clearDoneBtn   = document.getElementById('clear-done-btn');
const serverNote     = document.getElementById('server-note');
const howToStart     = document.getElementById('how-to-start');
const infoModal      = document.getElementById('info-modal');
const closeModal     = document.getElementById('close-modal');
const ffmpegWarn     = document.getElementById('ffmpeg-warn');
const ytdlpVersion   = document.getElementById('ytdlp-version');
const updateBtn      = document.getElementById('update-btn');
const videoFormatSel = document.getElementById('video-format');
const audioFormatSel = document.getElementById('audio-format');

// ── DOM refs – Web ─────────────────────────────────────────────────
const webUrlInput      = document.getElementById('web-url-input');
const webPasteBtn      = document.getElementById('web-paste-btn');
const webUrlHint       = document.getElementById('web-url-hint');
const webStatusDot     = document.getElementById('web-server-status');
const webDownloadBtn   = document.getElementById('web-download-btn');
const webDownloadList  = document.getElementById('web-download-list');
const webClearDoneBtn  = document.getElementById('web-clear-done-btn');
const webServerNote    = document.getElementById('web-server-note');
const webHowToStart    = document.getElementById('web-how-to-start');
const webFfmpegWarn    = document.getElementById('web-ffmpeg-warn');
const webYtdlpVersion  = document.getElementById('web-ytdlp-version');
const webFormatSel     = document.getElementById('web-format');

// ── DOM refs – Switcher ────────────────────────────────────────────
const switcherYt    = document.getElementById('switcher-yt');
const switcherWeb   = document.getElementById('switcher-web');
const ytInterface   = document.getElementById('yt-interface');
const webInterface  = document.getElementById('web-interface');
const appEl         = document.querySelector('.app');

// ══════════════════════════════════════════════════════════════════
//  APP SWITCHER
// ══════════════════════════════════════════════════════════════════
switcherYt.addEventListener('click', () => setAppMode('yt'));
switcherWeb.addEventListener('click', () => setAppMode('web'));

function setAppMode(m) {
  appMode = m;
  switcherYt.classList.toggle('active', m === 'yt');
  switcherWeb.classList.toggle('active', m === 'web');
  ytInterface.classList.toggle('hidden', m !== 'yt');
  webInterface.classList.toggle('hidden', m !== 'web');
  appEl.classList.toggle('web-mode', m === 'web');
  // Sync server status display when switching
  updateServerUI();
}

// ══════════════════════════════════════════════════════════════════
//  STORAGE HELPERS
// ══════════════════════════════════════════════════════════════════
function storageGet(key = STORAGE_KEY) {
  return new Promise(resolve => {
    chrome.storage.local.get(key, res => resolve(res[key] || []));
  });
}

function storageSet(list, key = STORAGE_KEY) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [key]: list.slice(-50) }, resolve);
  });
}

async function addDownloadItem(item, key = STORAGE_KEY) {
  const list = await storageGet(key);
  list.push(item);
  await storageSet(list, key);
  if (key === STORAGE_KEY) await renderDownloads();
  else await renderWebDownloads();
}

async function updateStoredDownload(id, patch, key = STORAGE_KEY) {
  const list = await storageGet(key);
  const updated = list.map(d => d.id === id ? { ...d, ...patch } : d);
  await storageSet(updated, key);
}

// ══════════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  loadCurrentTabUrl();
  await checkServer();
  await renderDownloads();
  await renderWebDownloads();
  startPolling();
});

// ── Current tab URL ────────────────────────────────────────────────
function loadCurrentTabUrl() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tabUrl = tabs[0]?.url;
    if (!tabUrl) return;
    if (isYouTubeUrl(tabUrl)) {
      urlInput.value = tabUrl;
      validateUrl();
    } else if (isVideoUrl(tabUrl)) {
      // Auto-fill web downloader if non-YT video page
      webUrlInput.value = tabUrl;
      validateWebUrl();
    }
  });
}

// ══════════════════════════════════════════════════════════════════
//  URL VALIDATION — YT
// ══════════════════════════════════════════════════════════════════
function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    return (
      ['www.youtube.com', 'youtube.com', 'youtu.be'].includes(u.hostname) &&
      (u.searchParams.has('v') || u.hostname === 'youtu.be' || u.pathname.startsWith('/shorts/'))
    );
  } catch { return false; }
}

function validateUrl() {
  const val = urlInput.value.trim();
  const valid = isYouTubeUrl(val);
  urlError.classList.toggle('hidden', val === '' || valid);
  downloadBtn.disabled = !(valid && serverOnline);
  return valid;
}

urlInput.addEventListener('input', validateUrl);

pasteBtn.addEventListener('click', async () => {
  try {
    urlInput.value = await navigator.clipboard.readText();
    validateUrl();
  } catch { urlInput.focus(); }
});

// ══════════════════════════════════════════════════════════════════
//  URL VALIDATION — WEB
// ══════════════════════════════════════════════════════════════════
function isVideoUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol.startsWith('http') && u.hostname.length > 0;
  } catch { return false; }
}

function detectSite(url) {
  try {
    const h = new URL(url).hostname.replace('www.', '');
    const known = {
      'twitter.com': 'Twitter/X', 'x.com': 'Twitter/X',
      'instagram.com': 'Instagram', 'reddit.com': 'Reddit',
      'vimeo.com': 'Vimeo', 'tiktok.com': 'TikTok',
      'dailymotion.com': 'Dailymotion', 'twitch.tv': 'Twitch',
      'facebook.com': 'Facebook', 'fb.watch': 'Facebook',
      'streamable.com': 'Streamable', 'rumble.com': 'Rumble',
    };
    return known[h] || h;
  } catch { return null; }
}

function validateWebUrl() {
  const val = webUrlInput.value.trim();
  if (!val) {
    webUrlHint.classList.add('hidden');
    webDownloadBtn.disabled = true;
    return false;
  }
  const valid = isVideoUrl(val);
  if (valid) {
    const site = detectSite(val);
    if (site) {
      webUrlHint.textContent = `Detected: ${site}`;
      webUrlHint.classList.remove('hidden');
    } else {
      webUrlHint.classList.add('hidden');
    }
    webDownloadBtn.disabled = !serverOnline;
  } else {
    webUrlHint.textContent = 'Enter a valid http/https URL';
    webUrlHint.classList.remove('hidden');
    webDownloadBtn.disabled = true;
  }
  return valid;
}

webUrlInput.addEventListener('input', validateWebUrl);

webPasteBtn.addEventListener('click', async () => {
  try {
    webUrlInput.value = await navigator.clipboard.readText();
    validateWebUrl();
  } catch { webUrlInput.focus(); }
});

// ══════════════════════════════════════════════════════════════════
//  MODE TABS (YT: video/audio)
// ══════════════════════════════════════════════════════════════════
tabVideo.addEventListener('click', () => setMode('video'));
tabAudio.addEventListener('click', () => setMode('audio'));

function setMode(m) {
  mode = m;
  tabVideo.classList.toggle('active', m === 'video');
  tabAudio.classList.toggle('active', m === 'audio');
  videoOptions.classList.toggle('hidden', m !== 'video');
  audioOptions.classList.toggle('hidden', m !== 'audio');
}

// ── YT Quality Pills ───────────────────────────────────────────────
document.querySelectorAll('#video-quality .pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#video-quality .pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    videoQuality = btn.dataset.value;
  });
});

document.querySelectorAll('#audio-quality .pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#audio-quality .pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    audioQuality = btn.dataset.value;
  });
});

// ── Web Quality Pills ──────────────────────────────────────────────
document.querySelectorAll('#web-quality .pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#web-quality .pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    webQuality = btn.dataset.value;
  });
});

// ══════════════════════════════════════════════════════════════════
//  SERVER HEALTH CHECK
// ══════════════════════════════════════════════════════════════════
async function checkServer() {
  [statusDot, webStatusDot].forEach(d => d.className = 'status-dot checking');
  try {
    const res  = await fetch(`${SERVER}/ping`, { signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    serverOnline = res.ok;
    const hasFfmpeg = data.ffmpeg !== false;
    ffmpegWarn.classList.toggle('hidden', !serverOnline || hasFfmpeg);
    webFfmpegWarn.classList.toggle('hidden', !serverOnline || hasFfmpeg);
    ytdlpVersion.textContent = 'by seyoj';
    webYtdlpVersion.textContent = data.ytdlp ? `v${data.ytdlp}` : '';
  } catch {
    serverOnline = false;
    ffmpegWarn.classList.add('hidden');
    webFfmpegWarn.classList.add('hidden');
  }
  updateServerUI();
}

function updateServerUI() {
  const cls = serverOnline ? 'online' : 'offline';
  const title = serverOnline ? 'Server online' : 'Server offline — run start_server.bat';
  statusDot.className = `status-dot ${cls}`;
  statusDot.title = title;
  webStatusDot.className = `status-dot ${cls}`;
  webStatusDot.title = title;

  serverNote.classList.toggle('hidden', serverOnline);
  webServerNote.classList.toggle('hidden', serverOnline);

  if (updateBtn) updateBtn.disabled = !serverOnline;

  // Re-validate both inputs against server state
  validateUrl();
  validateWebUrl();
}

// ══════════════════════════════════════════════════════════════════
//  YT DOWNLOAD
// ══════════════════════════════════════════════════════════════════
downloadBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!validateUrl() || !serverOnline) return;

  downloadBtn.disabled = true;
  try {
    const res = await fetch(`${SERVER}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        mode,
        quality:      mode === 'video' ? videoQuality : audioQuality,
        video_format: videoFormatSel.value,
        audio_format: audioFormatSel.value,
      }),
    });
    const data = await res.json();
    if (data.id) {
      await addDownloadItem({ id: data.id, title: data.title || url, status: 'pending', progress: 0, badge: 'Queued' }, STORAGE_KEY);
    } else {
      alert(data.error || 'Failed to start download');
    }
  } catch {
    alert('Could not connect to server.');
  } finally {
    downloadBtn.disabled = !serverOnline;
  }
});

// ══════════════════════════════════════════════════════════════════
//  WEB DOWNLOAD
// ══════════════════════════════════════════════════════════════════
webDownloadBtn.addEventListener('click', async () => {
  const url = webUrlInput.value.trim();
  if (!validateWebUrl() || !serverOnline) return;

  webDownloadBtn.disabled = true;
  try {
    const fmt = webFormatSel.value;
    const res = await fetch(`${SERVER}/download-web`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        quality:       webQuality,
        output_format: fmt,
      }),
    });
    const data = await res.json();
    if (data.id) {
      const site = detectSite(url) || url;
      await addDownloadItem(
        { id: data.id, title: data.title || site, status: 'pending', progress: 0, badge: 'Queued' },
        WEB_STORAGE_KEY
      );
    } else {
      alert(data.error || 'Failed to start download');
    }
  } catch {
    alert('Could not connect to server.');
  } finally {
    webDownloadBtn.disabled = !serverOnline;
  }
});

// ══════════════════════════════════════════════════════════════════
//  POLLING
// ══════════════════════════════════════════════════════════════════
function startPolling() {
  setInterval(async () => {
    await checkServer();
    await refreshActiveDownloads(STORAGE_KEY, renderDownloads);
    await refreshActiveDownloads(WEB_STORAGE_KEY, renderWebDownloads);
  }, POLL_INTERVAL);
}

async function refreshActiveDownloads(key, renderFn) {
  if (!serverOnline) return;
  const list = await storageGet(key);
  const active = list.filter(d => d.status === 'pending' || d.status === 'progress');
  if (!active.length) return;

  for (const item of active) {
    try {
      const res = await fetch(`${SERVER}/status/${item.id}`, { signal: AbortSignal.timeout(2000) });
      if (res.status === 404) {
        await updateStoredDownload(item.id, { status: 'error', badge: 'Lost (server restarted)' }, key);
        continue;
      }
      const data = await res.json();
      await updateStoredDownload(item.id, {
        status:   data.status,
        progress: data.progress ?? 0,
        badge:    statusBadge(data),
        title:    data.title || item.title,
      }, key);
    } catch { /* skip */ }
  }
  await renderFn();
}

function statusBadge(d) {
  if (d.status === 'done')     return 'Done';
  if (d.status === 'error')    return d.error || 'Error';
  if (d.status === 'progress') return `${Math.round(d.progress ?? 0)}%`;
  return 'Queued';
}

// ══════════════════════════════════════════════════════════════════
//  CLEAR DONE
// ══════════════════════════════════════════════════════════════════
clearDoneBtn.addEventListener('click', async () => {
  const list = await storageGet(STORAGE_KEY);
  await storageSet(list.filter(d => d.status !== 'done' && d.status !== 'error'), STORAGE_KEY);
  await renderDownloads();
});

webClearDoneBtn.addEventListener('click', async () => {
  const list = await storageGet(WEB_STORAGE_KEY);
  await storageSet(list.filter(d => d.status !== 'done' && d.status !== 'error'), WEB_STORAGE_KEY);
  await renderWebDownloads();
});

// ══════════════════════════════════════════════════════════════════
//  RENDER
// ══════════════════════════════════════════════════════════════════
async function renderDownloads() {
  renderToList(await storageGet(STORAGE_KEY), downloadList, false);
}

async function renderWebDownloads() {
  renderToList(await storageGet(WEB_STORAGE_KEY), webDownloadList, true);
}

function renderToList(rawList, container, isWeb) {
  const list = [...rawList].reverse();
  if (!list.length) {
    container.innerHTML = '<div class="empty-state">No downloads yet</div>';
    return;
  }

  container.innerHTML = list.map(item => {
    const cls = item.status === 'done'     ? 'done'
              : item.status === 'error'    ? 'error'
              : item.status === 'progress' ? 'progress'
              : 'pending';

    const badgeCls = ['done', 'error', 'pending'].includes(cls) ? cls : '';
    const progress = item.progress ?? 0;
    const showBar  = item.status === 'progress' || item.status === 'pending';
    const title    = escapeHtml(item.title || item.id);
    const webCls   = isWeb ? 'web-item' : '';

    return `
      <div class="download-item ${cls} ${webCls}">
        <div class="di-row">
          <span class="di-title" title="${title}">${title}</span>
          <span class="di-badge ${badgeCls}">${escapeHtml(item.badge || cls)}</span>
        </div>
        ${showBar ? `
        <div class="di-progress-bar">
          <div class="di-progress-fill" style="width:${progress}%"></div>
        </div>` : ''}
      </div>`;
  }).join('');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ══════════════════════════════════════════════════════════════════
//  UPDATE yt-dlp
// ══════════════════════════════════════════════════════════════════
if (updateBtn) {
  updateBtn.addEventListener('click', async () => {
    if (!serverOnline) return;
    updateBtn.disabled = true;
    updateBtn.textContent = 'Updating…';
    try {
      const res  = await fetch(`${SERVER}/update-ytdlp`, { method: 'POST' });
      const data = await res.json();
      updateBtn.textContent = data.ok ? 'Restart server to apply' : 'Update failed';
    } catch {
      updateBtn.textContent = 'Update failed';
    }
    setTimeout(() => {
      updateBtn.textContent = 'Update yt-dlp';
      updateBtn.disabled = !serverOnline;
    }, 4000);
  });
}

// ══════════════════════════════════════════════════════════════════
//  MODAL
// ══════════════════════════════════════════════════════════════════
[howToStart, webHowToStart].forEach(el => {
  el?.addEventListener('click', e => {
    e.preventDefault();
    infoModal.classList.remove('hidden');
  });
});

closeModal.addEventListener('click', () => infoModal.classList.add('hidden'));
infoModal.addEventListener('click', e => { if (e.target === infoModal) infoModal.classList.add('hidden'); });
