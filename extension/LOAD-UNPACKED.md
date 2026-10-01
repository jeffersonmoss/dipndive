# Load the Dip'n'Dive extension (unpacked)

Do this on each machine (Thing 1, Thing 2, iMac, the Windows PC). Chrome 116 or newer.

1. Get the code: `git clone` this repo (or `git pull` to update). Do not load it from the Google Drive folder.
2. Open `chrome://extensions`, switch on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension` folder inside the clone (the folder that contains `manifest.json`).
4. The extension ID must be `eokhjchjblklfkhcklpichdfjmmpcana` on every machine (the manifest carries a fixed key). If it differs, the key was lost; do not continue.
5. Open the extension's **Details**, then **Extension options**. Enter the companion URL (`https://jeffersons-imac.tailb5e03c.ts.net:8443` (port 8443; 443 on the iMac is the gbrain hub)) and the token (copy it by hand from the iMac, `~/Library/Application Support/DipDive/token`). Click **Save and test**.
6. Right-click any link, or the page, and choose **Dip'n'Dive**. The side panel opens. The five buttons change the mode; the menu runs the last mode chosen.

Notes:
- Until the companion runs behind `tailscale serve`, the only reachable address is `http://127.0.0.1:PORT` on the iMac itself. Saving that address makes Chrome ask once for permission to reach it.
- Host access is optional: saving the options page asks Chrome for permission to reach exactly that one address.
- Temp chat copies the source to the clipboard and opens a ChatGPT temporary chat; press Cmd/Ctrl+V and Enter yourself.
- To update: `git pull`, then click the reload arrow on the extension card.
