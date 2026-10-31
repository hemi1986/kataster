# Tech Stack Decision

Decide only once the event storming and a rough domain model exist. Before that, the facts are missing. Record the result as a large ADR (see [ADR-FORMAT.md](./ADR-FORMAT.md)), `status: proposed`.

## Criteria (evaluate each with evidence from `docs/`)

1. **On-site use**: Is work done on a device (phone/tablet)? What is the network coverage (Wi-Fi in the hall)? Offline required?
2. **Device features**: Camera, QR/barcode scanning, push notifications, offline use – is the browser (PWA) enough, or are native apps needed?
3. **User groups & access**: Public reporting (e.g. visitors) vs. internal team, roles, authentication.
4. **Other consumers**: Are there concrete additional clients or integrations today that justify a standalone API?
5. **Team & maintenance**: Who develops and runs this long-term? Which languages does the team know?
6. **Operations**: Hosting, cost, backups, updates – as few moving parts as possible.
7. **Future-proofing without up-front cost**: Does the option allow later expansion without paying for it today?

## Evaluate at least these options

- **A – Full-stack monolith as a PWA** (e.g. Next.js with a cleanly separated domain layer). One deployment, usable on mobile via browser/PWA.
- **B – Separate API (Go or TypeScript) + web app + mobile app**. Maximum decoupling, three codebases and release processes.
- **C – Hybrid**: monolith with a clearly separated domain/API layer now; extract an API or build a native app only when there is concrete need.

Evaluation as a table (criterion × option, with reasoning). The recommendation must follow from the table. Name effort differences explicitly. Uncertainties → propose a spike story.
