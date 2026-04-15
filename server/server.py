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
jobs: dict = {}
jobs_lock = threading.Lock()

AUDIO_BITRATES = {
    'low':    '128',
    'medium': '192',
    'high':   '320',
}

VIDEO_FORMAT_SPECS = {
    '1080': 'bestvideo[height=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height=1080]+bestaudio/best[height=1080]/best[ext=mp4]/best',
    '480':  'bestvideo[height=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height=480]+bestaudio/best[height=480]/best[ext=mp4]/best',
    '360':  'bestvideo[height=360][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height=360]+bestaudio/best[height=360]/best[ext=mp4]/best',
}

SAFE_YT_BROWSERS = {'chrome', 'edge', 'firefox', 'opera', 'brave', 'vivaldi'}

FORMATS = [
    {
        'label': '1920x1080 - mp4',
        'spec': 'bestvideo[height=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height=1080]+bestaudio/best[height=1080]/best[ext=mp4]/best',
    },
    {
        'label': '854x480 - mp4',
        'spec': 'bestvideo[height=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height=480]+bestaudio/best[height=480]/best[ext=mp4]/best',
    },
    {
        'label': '640x360 - mp4',
        'spec': 'bestvideo[height=360][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height=360]+bestaudio/best[height=360]/best[ext=mp4]/best',
    },
]

# Base yt-dlp options applied to every download
YDL_BASE: dict = {
    'quiet':            True,
    'no_warnings':      True,
    'noplaylist':       True,
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

@app.post('/download-web')
def start_web_download():
    """Download a video from any yt-dlp supported site (non-YouTube too)."""
    data = request.get_json(silent=True) or {}
    url  = data.get('url', '').strip()

    if not url:
        return jsonify({'error': 'No URL provided'}), 400

    # Basic URL sanity check — must be http/https
    if not re.match(r'https?://', url):
        return jsonify({'error': 'URL must start with http:// or https://'}), 400

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
        target=_run_web_download,
        args=(job_id, data),
        daemon=True,
    )
    thread.start()

    return jsonify({'id': job_id, 'title': url})


# Download worker
def _run_download(job_id: str, opts: dict):
    try:
        mode         = opts.get('mode', 'audio')
        quality      = str(opts.get('quality', '1080'))
        video_format = opts.get('video_format', 'mp4')
        audio_format = opts.get('audio_format', 'mp3')
        url          = opts['url']

        format_label = video_format if mode == 'video' else audio_format
        print(f'[Job {job_id}] Starting: {url} (mode={mode}, quality={quality}, fmt={format_label})')

        if mode not in {'audio', 'video'}:
            _patch(job_id, status='error', error='Invalid mode. Use "audio" or "video".')
            return

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

        _apply_safe_youtube_access(ydl_opts, opts)

        if FFMPEG_BIN:
            ydl_opts['ffmpeg_location'] = FFMPEG_BIN

        if mode == 'audio' and FFMPEG_OK:
            bitrate = AUDIO_BITRATES.get(quality, '192')
            ydl_opts.update({
                'format': 'bestaudio/best',
                'postprocessors': [{
                    'key':              'FFmpegExtractAudio',
                    'preferredcodec':   audio_format,
                    'preferredquality': bitrate,
                }],
            })
        elif mode == 'audio':
            abr_map = {'low': 130, 'medium': 200, 'high': 9999}
            abr = abr_map.get(quality, 200)
            ydl_opts['format'] = f'bestaudio[abr<={abr}]/bestaudio/best'
            _patch(job_id, error='ffmpeg missing — audio saved as native format (webm/m4a), not mp3')

        _patch(job_id, status='progress', progress=0)
        print(f'[Job {job_id}] Extracting info and downloading...')

        if mode == 'video':
            format_spec = VIDEO_FORMAT_SPECS.get(quality, VIDEO_FORMAT_SPECS['1080'])
            _patch(job_id, progress=5)
            try:
                _merge_video_with_audio(url, format_spec, opts)
                print('Download complete!')
            except subprocess.CalledProcessError as e:
                print(f'Error during download.\n{e.returncode}: {e.stderr}')
                raise

            title = url
            _patch(job_id, title=title)
        else:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=True)
                title = info.get('title', url) if info else url
                _patch(job_id, title=title)

        print(f'[Job {job_id}] Done: {title}')
        _patch(job_id, status='done', progress=100)

    except yt_dlp.utils.DownloadError as e:
        msg = str(e)
        print(f'[Job {job_id}] DownloadError: {msg}')
        if '403' in msg:
            msg = '403 Forbidden — try updating yt-dlp (button in extension Settings)'
        _patch(job_id, status='error', error=msg[:160])
    except Exception as e:
        print(f'[Job {job_id}] Error: {e}')
        _patch(job_id, status='error', error=f'Unexpected error: {e}'[:160])

# Web download worker — generic yt-dlp for any supported site
def _run_web_download(job_id: str, opts: dict):
    try:
        url           = opts['url']
        quality       = opts.get('quality', 'best[height<=720]')
        output_format = opts.get('output_format', 'mp4')

        print(f'[Job {job_id}] Web download: {url} (quality={quality}, fmt={output_format})')

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

        _apply_safe_youtube_access(ydl_opts, opts)

        if FFMPEG_BIN:
            ydl_opts['ffmpeg_location'] = FFMPEG_BIN

        if output_format == 'mp3' and FFMPEG_OK:
            ydl_opts['format'] = 'bestaudio/best'
            ydl_opts['postprocessors'] = [{
                'key':              'FFmpegExtractAudio',
                'preferredcodec':   'mp3',
                'preferredquality': '192',
            }]
        elif output_format == 'original':
            ydl_opts['format'] = quality
        else:
            # For mp4/webm try to get the right container; fall back gracefully
            if FFMPEG_OK:
                ydl_opts['format'] = quality
                ydl_opts['merge_output_format'] = output_format
            else:
                ydl_opts['format'] = quality

        _patch(job_id, status='progress', progress=0)

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = info.get('title', url) if info else url
            _patch(job_id, title=title)

        print(f'[Job {job_id}] Web download done: {title}')
        _patch(job_id, status='done', progress=100)

    except yt_dlp.utils.DownloadError as e:
        msg = str(e)
        print(f'[Job {job_id}] Web DownloadError: {msg}')
        _patch(job_id, status='error', error=msg[:200])
    except Exception as e:
        print(f'[Job {job_id}] Web Error: {e}')
        _patch(job_id, status='error', error=f'Unexpected error: {e}'[:200])


# Helpers
def _patch(job_id: str, **kwargs):
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(kwargs)

def _apply_safe_youtube_access(ydl_opts: dict, opts: dict):
    """Optionally add safer YouTube extraction settings to reduce bot checks."""
    if not opts.get('safe_access'):
        return

    # Default browser is Edge on Windows; caller can override with cookie_browser.
    browser = str(opts.get('cookie_browser', 'edge')).strip().lower()
    cookie_file = str(opts.get('cookie_file', '')).strip()

    # Add browser cookies when available (preferred) or explicit cookie file.
    if browser in SAFE_YT_BROWSERS:
        ydl_opts['cookiesfrombrowser'] = (browser,)
    elif cookie_file:
        ydl_opts['cookiefile'] = cookie_file

    # Enable a JS runtime when provided (e.g., node) to improve YouTube extraction.
    js_runtime = str(opts.get('js_runtime', '')).strip()
    if js_runtime:
        ydl_opts['js_runtimes'] = {js_runtime: None}

    # Slight pacing can help avoid aggressive rate limiting on repeated requests.
    ydl_opts['sleep_interval_requests'] = 1
    ydl_opts['max_sleep_interval_requests'] = 2

def _build_safe_youtube_cli_args(opts: dict) -> list[str]:
    """Build optional yt-dlp CLI args for safer YouTube extraction."""
    if not opts.get('safe_access'):
        return []

    args: list[str] = []
    browser = str(opts.get('cookie_browser', 'edge')).strip().lower()
    cookie_file = str(opts.get('cookie_file', '')).strip()

    if browser in SAFE_YT_BROWSERS:
        args += ['--cookies-from-browser', browser]
    elif cookie_file:
        args += ['--cookies', cookie_file]

    js_runtime = str(opts.get('js_runtime', '')).strip()
    if js_runtime:
        args += ['--js-runtimes', js_runtime]

    args += ['--sleep-requests', '1', '--max-sleep-interval', '2']
    return args

def _merge_video_with_audio(url: str, format_spec: str, opts: dict):
    command = _resolve_ytdlp_command()
    command += [url, '-f', format_spec, '--merge-output-format', 'mp4']
    command += _build_safe_youtube_cli_args(opts)

    if FFMPEG_BIN:
        command += ['--ffmpeg-location', FFMPEG_BIN]

    return subprocess.run(
        command,
        check=True,
        text=True,
        capture_output=True,
        cwd=str(DOWNLOAD_DIR),
    )

def _resolve_ytdlp_command() -> list[str]:
    # Prefer CLI when available; otherwise invoke yt-dlp module from current Python.
    ytdlp_cli = shutil.which('yt-dlp')
    if ytdlp_cli:
        return [ytdlp_cli]
    return [sys.executable, '-m', 'yt_dlp']

def _is_youtube_url(url: str) -> bool:
    pattern = r'(https?://)?(www\.)?(youtube\.com|youtu\.be)/(watch\?v=|shorts/|embed/)?[\w\-]+'
    return bool(re.match(pattern, url))

# Entry point
if __name__ == '__main__':
    print(f'[YT Downloader] Server starting on http://localhost:{PORT}')
    print(f'[YT Downloader] Files saved to: {DOWNLOAD_DIR}')
    if FFMPEG_OK:
        source = f'bundled ({_LOCAL_FF})' if _LOCAL_FF.exists() else 'system PATH'
        print(f'[YT Downloader] ffmpeg detected ({source}) — audio conversion available')
    else:
        print('[YT Downloader] WARNING: ffmpeg not found')
        print('  Audio will download as native format (webm/m4a), not mp3')
        print('  To fix: install ffmpeg and add it to PATH')
        print('  Quick install: winget install ffmpeg  OR  choco install ffmpeg')
    app.run(host='127.0.0.1', port=PORT, debug=False, threaded=True)