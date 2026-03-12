import re
import shutil
import subprocess
import sys
import threading
import uuid
from pathlib import Path
import yt_dlp
from flask import Flask, jsonify, request
from flask_cors import CORS

# Config
PORT         = 7979
DOWNLOAD_DIR = Path.home() / 'Downloads' / 'YT-Downloader'
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Look for ffmpeg
_BIN_DIR   = Path(__file__).parent.parent / 'bin'
_LOCAL_FF  = _BIN_DIR / 'ffmpeg.exe'

if _LOCAL_FF.exists():
    FFMPEG_BIN = str(_BIN_DIR)  
    FFMPEG_OK  = True
elif shutil.which('ffmpeg'):
    FFMPEG_BIN = None
    FFMPEG_OK  = True
else:
    FFMPEG_BIN = None
    FFMPEG_OK  = False

app = Flask(__name__)
CORS(app)

# In-memory job store 
# { job_id: { status, title, progress, error, file } }
jobs: dict = {}
jobs_lock = threading.Lock()

# Quality mappings
VIDEO_FORMATS_FFMPEG = {
    'low':    'bestvideo[height<=360]+bestaudio/best[height<=360]',
    'medium': 'bestvideo[height<=720]+bestaudio/best[height<=720]',
    'high':   'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
}
VIDEO_FORMATS_NOFFMPEG = {
    'low':    'best[height<=360]/best[height<=480]/best',
    'medium': 'best[height<=720]/best[height<=480]/best',
    'high':   'best[height<=1080]/best[height<=720]/best',
}

AUDIO_BITRATES = {
    'low':    '128',
    'medium': '192',
    'high':   '320',
}

# Base yt-dlp options applied to every download
YDL_BASE: dict = {
    'quiet':            True,
    'no_warnings':      True,
    'retries':          5,
    'fragment_retries': 5,
    'extractor_args': {
        'youtube': {
            'player_client': ['ios', 'android', 'web'],
        },
    },
}

# Routes

@app.get('/ping')
def ping():
    return jsonify({'ok': True, 'ffmpeg': FFMPEG_OK, 'ytdlp': yt_dlp.version.__version__})


@app.post('/download')
def start_download():
    data = request.get_json(silent=True) or {}
    url  = data.get('url', '').strip()

    if not url:
        return jsonify({'error': 'No URL provided'}), 400
    if not _is_youtube_url(url):
        return jsonify({'error': 'Not a YouTube URL'}), 400

    job_id = str(uuid.uuid4())[:8]

    with jobs_lock:
        jobs[job_id] = {
            'id':       job_id,
            'url':      url,
            'status':   'pending',
            'title':    url,
            'progress': 0,
            'error':    None,
            'file':     None,
        }

    thread = threading.Thread(
        target=_run_download,
        args=(job_id, data),
        daemon=True,
    )
    thread.start()

    return jsonify({'id': job_id, 'title': url})


@app.get('/status/<job_id>')
def get_status(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(job)


@app.get('/jobs')
def list_jobs():
    with jobs_lock:
        data = list(jobs.values())
    return jsonify(data)


@app.post('/update-ytdlp')
def update_ytdlp():
    """Run pip install -U yt-dlp in the background and return immediately."""
    def _do_update():
        subprocess.run(
            [sys.executable, '-m', 'pip', 'install', '-U', 'yt-dlp'],
            capture_output=True,
        )
    threading.Thread(target=_do_update, daemon=True).start()
    return jsonify({'ok': True, 'msg': 'Update started — restart the server when done'})


# Download worker

def _run_download(job_id: str, opts: dict):
    mode         = opts.get('mode', 'video')
    quality      = opts.get('quality', 'medium')
    video_format = opts.get('video_format', 'mp4')
    audio_format = opts.get('audio_format', 'mp3')
    url          = opts['url']

    def progress_hook(d):
        if d['status'] == 'downloading':
            raw = d.get('_percent_str', '0%').strip().replace('%', '')
            raw = re.sub(r'\x1b\[[0-9;]*m', '', raw)
            try:
                pct = float(raw)
            except ValueError:
                pct = 0
            _patch(job_id, status='progress', progress=pct)
        elif d['status'] == 'finished':
            _patch(job_id, progress=99)

    ydl_opts: dict = {
        **YDL_BASE,
        'outtmpl':        str(DOWNLOAD_DIR / '%(title)s.%(ext)s'),
        'progress_hooks': [progress_hook],
    }

    if FFMPEG_BIN:
        ydl_opts['ffmpeg_location'] = FFMPEG_BIN

    if mode == 'audio':
        if FFMPEG_OK:
            # Convert to the requested format at the chosen bitrate
            bitrate = AUDIO_BITRATES.get(quality, '192')
            ydl_opts.update({
                'format': 'bestaudio/best',
                'postprocessors': [{
                    'key':              'FFmpegExtractAudio',
                    'preferredcodec':   audio_format,
                    'preferredquality': bitrate,
                }],
            })
        else:
            # Map quality to approximate bitrate filter
            abr_map = {'low': 130, 'medium': 200, 'high': 9999}
            abr = abr_map.get(quality, 200)
            ydl_opts['format'] = f'bestaudio[abr<={abr}]/bestaudio/best'
            _patch(job_id, error='ffmpeg missing — audio saved as native format (webm/m4a), not mp3')
    else:
        if FFMPEG_OK:
            fmt = VIDEO_FORMATS_FFMPEG.get(quality, VIDEO_FORMATS_FFMPEG['medium'])
            ydl_opts['format'] = fmt
            if video_format in ('mp4', 'mkv', 'webm'):
                ydl_opts['merge_output_format'] = video_format
        else:
            # No ffmpeg: single-file progressive download (no merging needed)
            fmt = VIDEO_FORMATS_NOFFMPEG.get(quality, VIDEO_FORMATS_NOFFMPEG['medium'])
            ydl_opts['format'] = fmt
            # Can't force container without ffmpeg; skip merge_output_format

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            title = info.get('title', url) if info else url
            _patch(job_id, title=title, status='progress')

            ydl.download([url])

        _patch(job_id, status='done', progress=100)

    except yt_dlp.utils.DownloadError as e:
        msg = str(e)
        if '403' in msg:
            msg = '403 Forbidden — try updating yt-dlp (button in extension Settings)'
        _patch(job_id, status='error', error=msg[:160])
    except Exception as e:
        _patch(job_id, status='error', error=f'Unexpected error: {e}'[:160])


# Helpers

def _patch(job_id: str, **kwargs):
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(kwargs)


def _is_youtube_url(url: str) -> bool:
    pattern = r'(https?://)?(www\.)?(youtube\.com|youtu\.be)/(watch\?v=|shorts/|embed/)?[\w\-]+'
    return bool(re.match(pattern, url))


# Entry point

if __name__ == '__main__':
    print(f'[YT Downloader] Server starting on http://localhost:{PORT}')
    print(f'[YT Downloader] Files saved to: {DOWNLOAD_DIR}')
    if FFMPEG_OK:
        source = f'bundled ({_LOCAL_FF})' if _LOCAL_FF.exists() else 'system PATH'
        print(f'[YT Downloader] ffmpeg detected ({source}) — full quality + audio conversion available')
    else:
        print('[YT Downloader] WARNING: ffmpeg not found')
        print('  Video will download as single-file (max ~720p progressive stream)')
        print('  Audio will download as native format (webm/m4a), not mp3')
        print('  To fix: install ffmpeg and add it to PATH')
        print('  Quick install: winget install ffmpeg  OR  choco install ffmpeg')
    app.run(host='127.0.0.1', port=PORT, debug=False, threaded=True)
