# הכסף שלי — PWA

Static, no build. Data lives in the phone's localStorage and syncs to Supabase (key-gated RPCs).
No personal data in this folder — the phone connects with a code from `../tools/make-setup.js`
(output `../setup-code.txt`, outside the deploy) and pulls everything from the cloud.

Deploy: publish this folder as-is (GitHub Pages). Bump `VERSION` in `sw.js` on every deploy.
Preview hooks: `#seed` (sample data on an empty browser), `#now=2026-10-06`, `#tab=month`, `#add`, `#setup=MF1.…`.
