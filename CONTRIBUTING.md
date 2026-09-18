# Contributing to Browspark

Thanks for helping. Browspark is small and moves fast, so the rules are short.

## Before you start
- Search [existing issues](https://github.com/uncaughterrs/browspark/issues) first. Bugs need steps to reproduce, the browser and version, and the client you use (Claude Code, Codex, Cursor…).
- For anything larger than a bug fix, open an issue describing the change before writing code. It saves both of us from a pull request that cannot land.

## Setup
Browspark uses [Bun](https://bun.sh) for everything: install, run, bundle and test. There is no Node or npm step.

```bash
bun install
bun run build        # extension bundles
bun run typecheck
bun run --cwd frontend build # required before the landing-page smoke tests
bun test             # unit, bridge and landing-page tests; no browsers
bun run test:e2e     # launches throwaway Chromium browsers
bun run test:firefox # Firefox acceptance scenarios
bun run test:multi-browser # Chrome, Brave, Firefox and Zen together
```

Load `dist/chromium-extension/` (after `bun run build`) unpacked in Chrome or Brave, or load `dist/firefox-extension/manifest.json` through `about:debugging` in Firefox 153+ or a compatible Zen build. Run the matching companion from source with `bun companion/src/index.ts`. Multiple profiles can connect to the same companion; all four browsers also support separate developer contexts. Install the required browsers before running their acceptance suites, and run browser suites one at a time. See the [development reference](https://docs.browspark.krishm.dev/reference/development) for executable overrides and the full workflow.

## Pull requests
- Keep each pull request to one change. Small diffs get reviewed quickly.
- Match the existing style: TypeScript, no frameworks, no new dependencies unless a few lines cannot do the job.
- Run `bun run typecheck` and `bun test` before pushing. Add or update a test when you change behavior.
- Tool changes must keep the tool descriptions accurate, since agents read them. Run `bun run docs:tools` to regenerate the tool docs.
- Use conventional commit messages: `feat(extension): …`, `fix(companion): …`, `docs: …`.

## Publishing

`bun run release` checks npm authentication before publishing `browspark-mcp` and its `browspark` alias. If `bun pm whoami` returns **401 Unauthorized**, refresh the registry credentials before retrying. Bun's [documented login helper](https://bun.com/docs/pm/cli/pm#whoami) can run under Bun with `bunx --bun npm login`. If using a granular access token, verify that it is valid and grants publishing access to both packages; never commit the token.

A publish-time **404 Not Found** can mask rejected credentials even when the package exists. A new version being absent from npm is expected before publication. Check authentication first rather than changing the version to work around this error.

To check package contents without publishing, run these commands separately; `--dry-run` is not forwarded safely through the compound release command:

```bash
bun publish --access public --dry-run
(cd aliases/browspark && bun publish --access public --dry-run)
```

## Reporting security issues
Do not open a public issue for security problems. Email the maintainer instead and allow time for a fix before disclosure.

## License
By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
