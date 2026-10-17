# Contributing

Thanks for improving the grabber. Keep changes small, local, and testable.

## Ground rules

- No uploads, telemetry, remote services, or authentication/licensing bypasses.
- Do not commit downloaded course content, account data, cookies, or ZIPs.
- Keep `fflate` and `pdf.js` license headers intact.
- The extension must stay load-unpacked: no build step.

## Checklist

1. Edit the plain files (`content.js`, `background.js`, `mainworld.js`,
   `manifest.json`, `README.md`).
2. Bump `CS_VERSION` in `content.js` and `version` in `manifest.json` for
   injected-code changes.
3. Run `node --check content.js background.js mainworld.js`.
4. Load unpacked in Chrome/Edge 111+, reload the card, refresh the NetAcad page.
5. Smoke test:
   - panel appears and `data-ngb-cs` shows the new version;
   - **Copy text** on a real lesson;
   - **Save this page** produces a ZIP with `content.md`;
   - full course on a short free course produces `course.md`,
     `manifest.json` schema `netacad-grabber/2`, ordered modules/pages, and a
     downloaded ZIP;
   - exam/survey sections are skipped, not clicked.
6. For a bug report include course name, panel log tail, and `FAILURES.txt`.
7. Update README when output layout, permissions, or limitations change.

## Style

- Plain ES2020, no dependencies beyond the bundled `fflate`/`pdf.js`.
- Prefer small pure helpers and explicit error logs.
- Never let a failure silently produce an empty “successful” ZIP; append to
  `failures` / `FAILURES.txt`.
