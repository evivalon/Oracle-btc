ORACLE BTC — STANDALONE PWA PACKAGE

Files:
- index.html: complete single-page trading dashboard
- manifest.webmanifest: installable app metadata
- sw.js: caches the app shell for offline reopening
- icon-192.png / icon-512.png: app icons

IMPORTANT:
This package must be deployed to an HTTPS host (for example, a static site host)
before iPhone can install it as a Home Screen web app. Live BTC data and historical
candles require an internet connection. The UI shell can reopen offline after it
has been loaded once. Market data and predictions are not available offline.

iPhone installation:
1. Deploy the contents of this folder to an HTTPS static site.
2. Open the HTTPS URL in Safari.
3. Tap Share > Add to Home Screen.
4. Enable "Open as Web App" if shown, then tap Add.
