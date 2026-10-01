# Load the Dip and Dive extension (unpacked)

Do this on each machine (Thing 1, Thing 2, iMac, the Windows PC). Chrome 114 or newer.

1. Get the code: `git clone` this repo (or `git pull` to update). Do not load it from the Google Drive folder.
2. Open `chrome://extensions`, switch on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension` folder inside the clone (the folder that contains `manifest.json`).
4. The extension ID must be `eokhjchjblklfkhcklpichdfjmmpcana` on every machine (the manifest carries a fixed key). If it differs, the key was lost; do not continue.
5. Open the extension's **Details**, then **Extension options**. Enter the companion URL (the iMac's `https://<imac>.<tailnet>.ts.net` address from `tailscale serve`) and the token (copy it by hand from the iMac, `~/Library/Application Support/DipDive/token`). Click **Save and test**.
6. Right-click any link, or the page, and choose **Dip and Dive: Codex Dip**. The side panel opens. The five buttons change the mode; the menu label follows the last choice.

Notes:
- Until the companion runs behind `tailscale serve`, the only reachable address is `http://127.0.0.1:PORT` on the iMac itself. Saving that address makes Chrome ask once for permission to reach it.
- The manifest allows `https://*.ts.net/*`. Once the exact tailnet name is known it can be narrowed to that one host.
- Temp chat copies the source to the clipboard and opens a ChatGPT temporary chat; press Cmd/Ctrl+V and Enter yourself.
- To update: `git pull`, then click the reload arrow on the extension card.
