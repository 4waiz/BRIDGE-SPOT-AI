# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased]

### Added
- Shared Bridge Spot app shell (`spot/frontend/bridge-shell.js`): dark sidebar, top bar, notifications, user menu, Spot status + telemetry dialog, modal/toast UI kit and the inline icon set, injected into every page.
- New platform pages in the Spot UI: `dashboard.html`, `missions.html` (natural-language mission builder), `reports.html` (generate/preview/download), `assets.html` (asset health register) and `settings.html` (connection, assistant, appearance, local data).
- Shared demo dataset `spot/frontend/platform.data.js` for missions, assets, reports, findings and activity.
- Smart Assistant text input on the home screen — questions can now be typed as well as spoken.

### Changed
- Redesigned the Spot UI (`http://localhost:4000/static/index.html`) as a single design system in `spot/frontend/styles.css`; the launcher is now a dashboard-style home screen with hero, quick actions and mission modules.
- Brand lockups are now images: `brand-sidebar.png` in the sidebar and `brand-hero.png` (plus a light-ink `brand-hero-dark.png` for dark mode) in the hero, trimmed from the supplied `sidebar.png` / `home.png`.
- Quick Actions moved to the foot of the home screen, spanning the full content width.
- The UI is scaled to 125% at 100% browser zoom (`html { font-size: 125% }`), with every breakpoint scaled to match.
- Digital Factory and HSSE inspection pages restyled onto the shared shell; their data logic (`digital_factory.js`, `hsse.js`) is unchanged, with presentation handled by the new `inspection.js`.
- Mission module cards and the demo detail dialog (`usecases.js`) now render through the shared modal.

### Fixed
- The voice assistant no longer blocks the page with `alert()` when a browser has no speech recognition, and no longer throws when speech synthesis is unavailable.

### Removed
- `spot/frontend/digital_factory.css` and `spot/frontend/hsse.css` — superseded by the shared `styles.css`.
- The "Bridge Spot is a demonstration platform" footer line.

