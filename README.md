# הכסף שלי — PWA

Static, no build, no backend. All user data lives in the phone's localStorage.
No personal data in this folder — May's plan arrives via a one-time setup code
(`../tools/make-setup.js`, output `../setup-code.txt`, both outside the deploy).

Deploy: publish this folder as-is (GitHub Pages). Bump `VERSION` in `sw.js` on every deploy.
Preview hooks: `#now=2026-10-06`, `#tab=month`, `#add`, `#seed`, `#setup=MF1.…`.
