# YT-downloader

A browser extension UI and a Python server for supporting download-related functionality.

Contents
- `extension/` — browser extension sources (manifest.json, popup.html, popup.js, icons).
- `server/` — Python server and helper scripts (`server.py`, `requirements.txt`, `generate_icons.py`).
- `install_deps.bat`, `start_server.bat` — convenience scripts for Windows.

Quick start (Windows)
1. Install dependencies:

   - Option A (recommended): run the bundled script from the project root:

     ```powershell
     .\install_deps.bat
     ```

   - Option B (manual): ensure Python 3.8+ is installed and run:

     ```powershell
     pip install -r server\requirements.txt
     ```

2. Start the server (from project root):

   ```powershell
   .\start_server.bat
   # or
   python server\server.py
   ```

3. Load the extension into your Chromium-based browser (for development):

   - Open `chrome://extensions` (or Edge extensions page).
   - Enable "Developer mode".
   - Click "Load unpacked" and select the `extension/` folder from this project.
   - The extension popup is `extension/popup.html` and its behavior is defined in `popup.js`.

Development notes
- To regenerate or create icons, see `server/generate_icons.py`.
- The server lives in `server/` and can be extended to add API endpoints used by the extension.
- If you change extension files, reload the unpacked extension in the browser to see updates.

Files of interest
- `extension/manifest.json` — extension configuration and permissions.
- `extension/popup.html` — UI shown in the extension popup.
- `server/server.py` — lightweight server used during development.

Contributing
- Open issues or send a PR with focused changes. Describe how to reproduce and test.

License
- This project is licensed under the MIT License — see the `LICENSE` file in the project root for details. Replace the placeholder copyright holder in `LICENSE` with your name or organization.

Questions
- Tell me if you want this README expanded (usage examples, endpoints, screenshots, license).
