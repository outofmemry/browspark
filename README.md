<div align="center">
    <img src="docs/images/logo.png" title="Browspark" alt="Browspark logo" width="120" />
    <h1>Browspark</h1>
    <p>
        Give your AI agent a real browser.
        <br>
        One local MCP server for Chrome, Brave, Firefox and Zen, running side by side.
    </p>
    <a href="https://browspark.krishm.dev/">Website</a>
    ·
    <a href="https://docs.browspark.krishm.dev/">Documentation</a>
</div>

Agent work stays in the background by default. Change **Settings → Work in background** if an operation needs foreground interaction.

## Install
> [!NOTE]
> Browspark is in early release. If something breaks, please [open an issue](https://github.com/uncaughterrs/browspark/issues).

Requires [Bun](https://bun.sh) and a supported browser. Chrome, Brave, Firefox and Zen can share existing tabs through their matching extension; all four also support separate developer sessions.

### Option 1: one command

Downloads the extension, registers the companion with the agents you pick, and walks you through the last steps. Add `--test` for a dry run that changes nothing.

```bash
curl -fsSL https://browspark.krishm.dev/setup.sh | bash
```

### Option 2: by hand

**1. Register the companion** with your MCP client. It is published on npm as [`browspark-mcp`](https://www.npmjs.com/package/browspark-mcp); no clone needed.

```bash
claude mcp add browspark -- bunx browspark-mcp@latest
```

Codex, OpenCode, Cursor, Antigravity and Muse Code are covered in the [connect guide](https://docs.browspark.krishm.dev/connect/agents).

**2. Get the extension.** Download `browspark-extension.zip` from the [latest release](https://github.com/uncaughterrs/browspark/releases/latest) and unzip it, or clone this repo and run `bun install && bun run build` to use the `dist/chromium-extension/` folder. Open `chrome://extensions` in Chrome or `brave://extensions` in Brave, turn on Developer mode, choose **Load unpacked** and select that folder. Repeat in each browser profile you want to connect; they can all use the same companion.

**3. Share tabs.** Open each extension dashboard and share the tabs the agent may use. The [Graph page](https://docs.browspark.krishm.dev/dashboard/graph) shows agents and browsers on a draggable canvas with logos and animated connections; toggle it in Settings. Ask the agent to call `browser_status` to select a listed `tabId` or use its `browserId` when opening a new tab. Sharing permissions stay separate in each browser profile.

**Using Firefox or Zen?** With Firefox 153+ or a Zen build based on Firefox 153+, run `bun install && bun run package` in this checkout. Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → `dist/firefox-extension/manifest.json` (or `dist/browspark-firefox-extension.zip`). Register the matching source companion with command `bun` and the absolute path to `companion/src/index.ts`. Open Browspark, enable user scripts when prompted and share your existing tabs. This unsigned build needs loading again after a browser restart. See [Firefox extension setup and exceptions](https://docs.browspark.krishm.dev/reference/firefox).

## What it does
- **Extension mode.** The agent drives shared tabs in Chrome, Brave, Firefox and Zen at the same time, keeping your signed-in sessions. Each browser enforces its own sharing permissions. Firefox and Zen use a separate extension build with documented automation and debugging limits.
- **Developer mode.** Launch separate Chrome, Brave, Firefox or Zen contexts with persistent profiles. Chromium browsers provide CDP and Lighthouse; Firefox and Zen use the same tool names for supported BiDi operations and report unsupported actions explicitly.
- **Developer tools as first-class tools.** Console, Network, Sources, Debugger, Elements, Performance, CPU and memory profiling, storage, service workers, coverage, emulation, accessibility, security, Lighthouse and a recorder that exports Playwright tests.

The full tool reference is at [docs.browspark.krishm.dev/tools](https://docs.browspark.krishm.dev/tools/overview).

<p align="center"><img src="docs/images/dashboard-overview-dark.png" width="800" alt="Dashboard overview, dark theme"></p>

## Development
```bash
bun install
bun run build            # Chromium extension/ + dist/firefox-extension/
bun run typecheck
bun run --cwd frontend build # build landing page before its smoke tests
bun test                 # unit, bridge and landing-page tests; no browsers
bun run docs:tools       # schema-validated tool reference
bun run test:e2e         # launches throwaway Chromium browsers
bun run test:firefox     # Firefox acceptance scenarios
bun run test:multi-browser # Chrome, Brave, Firefox and Zen together
bun run package          # Chromium and Firefox extension ZIPs in dist/
cd docs && bunx mint dev # preview the docs site
```

Install the browsers needed for each acceptance suite; the [development guide](https://docs.browspark.krishm.dev/reference/development) lists executable overrides. Run browser suites one at a time.

Layout: `companion/` (MCP server, transports, devtools modules), `extension/` (MV3 dashboard and worker: `shared/` source plus `chromium/` and `firefox/` manifests), `shared/` (wire protocol), `docs/` (Mintlify site), `frontend/` (landing page), `test-apps/` (deterministic pages for tests).

## Contributing
Before contributing, please read the guidelines in [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

### We believe in open source
Browspark exists because other people published their work for anyone to build on, and it is published under the same terms. Every line of the companion, the extension, the docs and the landing page is in this repository, so you can read exactly what runs on your machine and what touches your browser.


### Model Context Protocol
The tools and the server are built on the [Model Context Protocol](https://modelcontextprotocol.io) and its TypeScript SDK. MCP is what lets one companion serve Claude Code, Codex, Cursor and every other client through the same interface.


### Chromium
Chromium support uses the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) and the extension `debugger` API. The developer tools it exposes are the same ones the DevTools panels use. Firefox and Zen developer sessions use [WebDriver BiDi](https://firefox-source-docs.mozilla.org/remote/index.html).


### Supabase
The dashboard and landing page take their visual direction from [Supabase](https://supabase.com): a neutral dark palette, a single green accent, and interfaces that stay out of the way. Thanks for showing that developer tools can be calm and good looking.


## License
Browspark is licensed under the MIT License. See [LICENSE](LICENSE).
