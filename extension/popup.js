const SERVER = 'http://localhost:7979';
const POLL_INTERVAL = 1500;
const STORAGE_KEY   = 'yt_downloads';

// State
let mode = 'video';
let videoQuality = '1080';
let audioQuality = 'medium';
let serverOnline  = false;

// DOM refs
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
const ffmpegWarn    = document.getElementById('ffmpeg-warn');
const ytdlpVersion  = document.getElementById('ytdlp-version');
const updateBtn     = document.getElementById('update-btn');
const videoFormatSel = document.getElementById('video-format');
const audioFormatSel = document.getElementById('audio-format');

// Storage helpers (chrome.storage.local, promise-wrapped)
function storageGet() {
  return new Promise(resolve => {
    chrome.storage.local.get(STORAGE_KEY, res => resolve(res[STORAGE_KEY] || []));
  });
}

function storageSet(list) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [STORAGE_KEY]: list.slice(-50) }, resolve);
  });
}

async function addDownloadItem(item) {
  const list = await storageGet();
  list.push(item);
  await storageSet(list);
  await renderDownloads();
}

async function updateStoredDownload(id, patch) {
  const list = await storageGet();
  const updated = list.map(d => d.id === id ? { ...d, ...patch } : d);
  await storageSet(updated);
}

// Init
document.addEventListener('DOMContentLoaded', async () => {
  loadCurrentTabUrl();
  await checkServer();
  await renderDownloads();
  startPolling();
});

// Current tab URL
function loadCurrentTabUrl() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]?.url && isYouTubeUrl(tabs[0].url)) {
      urlInput.value = tabs[0].url;
      validateUrl();
    }
  });
}

// URL validation
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

// Mode tabs
tabVideo.addEventListener('click', () => setMode('video'));
tabAudio.addEventListener('click', () => setMode('audio'));

function setMode(m) {
  mode = m;
  tabVideo.classList.toggle('active', m === 'video');
  tabAudio.classList.toggle('active', m === 'audio');
  videoOptions.classList.toggle('hidden', m !== 'video');
  audioOptions.classList.toggle('hidden', m !== 'audio');
}

// Quality pills
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

// Server health check
async function checkServer() {
  statusDot.className = 'status-dot checking';
  try {
    const res  = await fetch(`${SERVER}/ping`, { signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    serverOnline = res.ok;
    ffmpegWarn.classList.toggle('hidden', !serverOnline || data.ffmpeg !== false);
    if (data.ytdlp) ytdlpVersion.textContent = `yt-dlp ${data.ytdlp}`;
  } catch {
    serverOnline = false;
    ffmpegWarn.classList.add('hidden');
  }
  statusDot.className = `status-dot ${serverOnline ? 'online' : 'offline'}`;
  statusDot.title = serverOnline ? 'Server online' : 'Server offline — run start_server.bat';
  serverNote.classList.toggle('hidden', serverOnline);
  updateBtn.disabled = !serverOnline;
  downloadBtn.disabled = !(serverOnline && isYouTubeUrl(urlInput.value.trim()));
}

// Download
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
      await addDownloadItem({ id: data.id, title: data.title || url, status: 'pending', progress: 0, badge: 'Queued' });
    } else {
      alert(data.error || 'Failed to start download');
    }
  } catch {
    alert('Could not connect to server.');
  } finally {
    downloadBtn.disabled = !serverOnline;
  }
});

// Polling
function startPolling() {
  setInterval(async () => {
    await checkServer();
    await refreshActiveDownloads();
  }, POLL_INTERVAL);
}

async function refreshActiveDownloads() {
  if (!serverOnline) return;
  const list = await storageGet();
  const active = list.filter(d => d.status === 'pending' || d.status === 'progress');
  if (!active.length) return;

  for (const item of active) {
    try {
      const res = await fetch(`${SERVER}/status/${item.id}`, { signal: AbortSignal.timeout(2000) });
      if (res.status === 404) {
        // Job no longer exists on server (server restarted) — mark as error
        await updateStoredDownload(item.id, {
          status: 'error',
          badge:  'Lost (server restarted)',
        });
        continue;
      }
      const data = await res.json();
      await updateStoredDownload(item.id, {
        status:   data.status,
        progress: data.progress ?? 0,
        badge:    statusBadge(data),
        title:    data.title || item.title,
      });
    } catch { /* skip */ }
  }
  await renderDownloads();
}

function statusBadge(d) {
  if (d.status === 'done')     return 'Done';
  if (d.status === 'error')    return d.error || 'Error';
  if (d.status === 'progress') return `${Math.round(d.progress ?? 0)}%`;
  return 'Queued';
}

// Clear done
clearDoneBtn.addEventListener('click', async () => {
  const list = await storageGet();
  await storageSet(list.filter(d => d.status !== 'done' && d.status !== 'error'));
  await renderDownloads();
});

// Render
async function renderDownloads() {
  const list = [...(await storageGet())].reverse();
  if (!list.length) {
    downloadList.innerHTML = '<div class="empty-state">No downloads yet</div>';
    return;
  }

  downloadList.innerHTML = list.map(item => {
    const cls = item.status === 'done'     ? 'done'
              : item.status === 'error'    ? 'error'
              : item.status === 'progress' ? 'progress'
              : 'pending';

    const badgeCls = ['done', 'error', 'pending'].includes(cls) ? cls : '';
    const progress = item.progress ?? 0;
    const showBar  = item.status === 'progress' || item.status === 'pending';
    const title    = escapeHtml(item.title || item.id);

    return `
      <div class="download-item ${cls}">
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

// Update yt-dlp
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

// Modal
howToStart.addEventListener('click', e => {
  e.preventDefault();
  infoModal.classList.remove('hidden');
});

closeModal.addEventListener('click', () => infoModal.classList.add('hidden'));
infoModal.addEventListener('click', e => { if (e.target === infoModal) infoModal.classList.add('hidden'); });
