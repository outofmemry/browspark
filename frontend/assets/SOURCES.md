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

All assets are local. Render client marks with `object-fit: contain`; no color filters are needed.

## Product screenshot

`dashboard-graph.png` is a 2242 × 1338 screenshot of Browspark's actual Graph card, captured on 2026-09-17 in a disposable Chrome profile using `companion/test/harness.ts`. Four local MCP test sessions identify as Codex, Claude Code, Cursor and OpenCode. Chrome runs the real extension; Brave, Firefox and Zen are simulated extension connections using the normal bridge protocol. This is an illustrative topology, not a browser compatibility test, and contains no real user browsing data.

The capture uses a 1440 × 880 CSS-pixel viewport at 2× resolution. After all connections and logos load, **Reset** restores the default node positions and **Fit** brings every node into view. Chrome captures the `#connection-graph` element directly, including the dotted canvas, connection lines, logos and Fit/Reset controls; the screenshot is not retouched. Dark and light captures of the same layout are also stored in `docs/images/dashboard-graph-dark.png` and `docs/images/dashboard-graph-light.png`.
