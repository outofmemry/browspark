# Brand assets

Browspark's logo is the user-provided `extension/shared/assets/logo.png`, originally supplied as `/Users/krishmakhijani/Downloads/logo.png`. `logo.png` (128 × 128) and `favicon.png` (32 × 32) are proportional PNG exports using macOS `sips`; composition and colors are unchanged.

Client marks were copied from the extension's officially sourced assets, retrieved on 2026-09-12. Logos belong to their respective owners. No client mark was redrawn or recolored.

| File | Official source | Treatment |
| --- | --- | --- |
| `clients/claude.png` | [Claude website icon](https://claude.com/icon.png) | Original 32 × 32 transparent PNG. |
| `clients/codex.svg` | [OpenAI Agents SDK favicon](https://raw.githubusercontent.com/openai/openai-agents-js/main/docs/public/favicon.svg) | Original OpenAI Blossom on a white circular tile, used to identify Codex. This is the OpenAI mark, not a dedicated Codex app icon. |
| `clients/opencode.svg` | [OpenCode brand page](https://opencode.ai/brand/), original `logoDarkSquareSvg` download | Original 300 × 300 SVG variant intended for dark backgrounds. |
| `clients/cursor.svg` | [Cursor brand page](https://cursor.com/brand), [official asset archive](https://ptht05hbb1ssoooe.public.blob.vercel-storage.com/assets/brand/cursor-brand-assets.zip), member `General Logos/Cube/SVG/CUBE_2D_DARK.svg` | Original SVG variant intended for dark backgrounds. |
| `clients/antigravity.png` | [Google Antigravity press assets](https://www.antigravity.google/press), [full-color icon](https://www.antigravity.google/assets/image/brand/antigravity-icon__full-color.png) | Proportional 64 × 64 transparent PNG export using macOS `sips`. |
| `clients/muse.svg` | [Simple Icons `meta` mark](https://cdn.simpleicons.org/meta), reproducing Meta's loop mark | 24 × 24 single-color `#0467DF` SVG as supplied, used to identify Muse Code. This is the Meta mark, not a dedicated Muse Code app icon. |
| `clients/hermes.png` | Copy of `extension/shared/assets/clients/hermes.png`, see that folder's `SOURCES.md` | Same official Hermes squircle app icon as the dashboard graph uses. |
| `clients/cline.png` | [Cline official favicon](https://cline.bot/assets/branding/favicons/favicon-256x256.png) | Original 256 × 256 PNG as supplied. |
| `clients/kilo.svg` | [Kilo Code official favicon](https://kilocode.ai/favicon/favicon.svg?v=2) | Original SVG as supplied (dark pixel mark on a light tile). |
| `clients/openclaw.svg` | [OpenClaw official favicon](https://openclaw.ai/favicon.svg) | Original SVG as supplied. |
| `clients/pi.svg` | [Pi official favicon](https://pi.dev/favicon.svg) | Original SVG as supplied; uses `prefers-color-scheme` so the mark is light on dark backgrounds. |
| `clients/commandcode.png` | [Command Code official favicon](https://commandcode.ai/favicon/2024/favicon-32x32.png) | Original 32 × 32 PNG as supplied. |

All assets are local. Render client marks with `object-fit: contain`; no color filters are needed.

## Browser marks

`browsers/chrome.svg`, `browsers/brave.svg`, `browsers/firefox.png` and `browsers/zen.svg` are unmodified copies of the extension's officially sourced browser marks; see `extension/shared/assets/browsers/SOURCES.md` for their origins. The hero graph uses them to identify example browser profiles; their inclusion does not imply endorsement or additional automation support.

## Product screenshot

`dashboard-graph.png` is a 2178 × 1370 screenshot of the redesigned dashboard's actual Graph card, captured on 2026-10-05. The dashboard code is unmodified; for a reproducible layout it ran in a local preview page that answers the dashboard's `chrome.runtime` messages with fixed sample state instead of a live worker. The sample graph has four agents (Codex, Claude Code, Cursor, OpenCode) and four browser profiles (Chrome, Brave, Firefox, Zen), each with one shared tab. This is an illustrative topology, not a browser compatibility test, and contains no real user browsing data.

The capture uses a 1440 × 880 CSS-pixel viewport at 2× resolution in headless Chromium. After the logos load, **Reset** restores the default node positions and **Fit** brings every node into view; the `#connection-graph` element is captured directly, including the dotted canvas, connection lines, logos and controls, and is not retouched. Dark and light captures of the same layout are also stored in `docs/images/dashboard-graph-dark.png` and `docs/images/dashboard-graph-light.png`.

## Browser marks

`browsers/chrome.svg`, `browsers/brave.svg`, `browsers/firefox.png` and `browsers/zen.svg` are unmodified copies of the extension's officially sourced browser marks; see `extension/shared/assets/browsers/SOURCES.md` for their origins. The hero graph uses them to identify example browser profiles; their inclusion does not imply endorsement or additional automation support.

## Product screenshot

`dashboard-graph.png` is a 2242 × 1338 screenshot of Browspark's actual Graph card, captured on 2026-09-17 in a disposable Chrome profile using `companion/test/harness.ts`. Four local MCP test sessions identify as Codex, Claude Code, Cursor and OpenCode. Chrome runs the real extension; Brave, Firefox and Zen are simulated extension connections using the normal bridge protocol. This is an illustrative topology, not a browser compatibility test, and contains no real user browsing data.

The capture uses a 1440 × 880 CSS-pixel viewport at 2× resolution. After all connections and logos load, **Reset** restores the default node positions and **Fit** brings every node into view. Chrome captures the `#connection-graph` element directly, including the dotted canvas, connection lines, logos and Fit/Reset controls; the screenshot is not retouched. Dark and light captures of the same layout are also stored in `docs/images/dashboard-graph-dark.png` and `docs/images/dashboard-graph-light.png`.
