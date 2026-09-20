#!/usr/bin/env bash
# Browspark setup: downloads the extension and registers the companion with your agent.
#   curl -fsSL https://browspark.krishm.dev/setup.sh | bash
#   bash setup.sh --test   # dry run: no download, writes no config
set -euo pipefail

TEST=0; [ "${1:-}" = "--test" ] && TEST=1

ZIP_URL="${BROWSPARK_ZIP_URL:-https://github.com/outofmemry/browspark/releases/latest/download/browspark-extension.zip}"
EXT_DIR="$HOME/browspark-extension"
PKG="browspark-mcp@latest"

# Palette: the dashboard's neutral dark theme with its green accent.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  G=$'\e[38;2;77;171;154m' B=$'\e[1m' D=$'\e[38;5;245m' W=$'\e[38;2;236;236;236m' Y=$'\e[38;2;222;170;80m' R=$'\e[38;2;224;96;96m' X=$'\e[0m'
else
  G='' B='' D='' W='' Y='' R='' X=''
fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$X" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$X" "$*"; }
fail() { printf '  %s✗%s %s\n' "$R" "$X" "$*" >&2; exit 1; }
dim()  { printf '  %s%s%s\n' "$D" "$*" "$X"; }
step() { printf '\n%s%s%s  %s%s%s\n' "$G" "$1" "$X" "$B" "$2" "$X"; }
ask()  { printf '  %s›%s %s ' "$G" "$X" "$1" >&2; local a; read -r a < /dev/tty; printf '%s' "$a"; }
# In --test mode, print the change instead of making it.
run()  { if [ "$TEST" = 1 ]; then dim "would run: $*" >&2; else "$@"; fi; }

printf '\n  %s●%s %s%sBrowspark%s\n' "$G" "$X" "$B" "$W" "$X"
dim "Your browser. Now agent-ready."
[ "$TEST" = 1 ] && warn "Test mode: nothing is downloaded or changed."

# 01 ───────────────────────────────────────────────────────────────────────────
step 01 "Checking requirements"
for t in curl unzip; do command -v "$t" >/dev/null || fail "$t is required."; done
if command -v bun >/dev/null; then
  ok "Bun $(bun --version)"
else
  warn "Bun is not installed. The companion runs on Bun even when launched with npx or pnpm."
  a=$(ask "Install Bun from bun.sh now? [y/N]")
  case "$a" in
    y|Y) run bash -c 'curl -fsSL https://bun.sh/install | bash >/dev/null'; export PATH="$HOME/.bun/bin:$PATH"; command -v bun >/dev/null || fail "Bun install did not complete. See https://bun.sh"; ok "Bun $(bun --version)";;
    *) fail "Install Bun first: curl -fsSL https://bun.sh/install | bash";;
  esac
fi

# 02 ───────────────────────────────────────────────────────────────────────────
step 02 "Downloading the Chromium extension"
if [ "$TEST" = 1 ]; then
  dim "would download: $ZIP_URL"
  dim "would unzip to:  $EXT_DIR"
else
  tmp=$(mktemp -t browspark.XXXXXX)
  trap 'rm -f "$tmp"' EXIT
  curl -fsSL "$ZIP_URL" -o "$tmp" || fail "Download failed: $ZIP_URL"
  rm -rf "$EXT_DIR" && mkdir -p "$EXT_DIR" && unzip -qo "$tmp" -d "$EXT_DIR"
  [ -f "$EXT_DIR/manifest.json" ] || fail "The archive did not contain an extension."
  ok "Saved to $EXT_DIR"
fi

# 03 ───────────────────────────────────────────────────────────────────────────
step 03 "Choose how to run the companion"
dim "1) bun    bunx $PKG"
dim "2) pnpm   pnpm dlx $PKG"
dim "3) npm    npx -y $PKG"
a=$(ask "Package manager [1]:")
case "${a:-1}" in
  2) CMD=pnpm; ARGS="dlx $PKG";;
  3) CMD=npx;  ARGS="-y $PKG";;
  *) CMD=bunx; ARGS="$PKG";;
esac
command -v "$CMD" >/dev/null || warn "$CMD is not on your PATH yet; the config is written anyway."
RUN="$CMD $ARGS"
ok "$RUN"

# 04 ───────────────────────────────────────────────────────────────────────────
step 04 "Choose your agents"
AGENTS="claude codex opencode cursor antigravity muse"
i=0; for n in $AGENTS; do i=$((i+1)); dim "$i) $n"; done
a=$(ask "Numbers separated by spaces, or 'all' [1]:")
a=${a:-1}
[ "$a" = all ] && a="1 2 3 4 5 6"
CHOSEN=""
for n in $a; do
  j=0; for name in $AGENTS; do j=$((j+1)); [ "$j" = "$n" ] && CHOSEN="$CHOSEN $name"; done
done
[ -n "$CHOSEN" ] || fail "No agent selected."

# Merge {path: value} into a JSON config, creating the file if needed. Uses Bun so no jq is required.
merge_json() { # file dotted.path json
  mkdir -p "$(dirname "$1")"
  bun -e '
    const [file, path, value] = process.argv.slice(1);
    let root = {};
    try { root = JSON.parse(await Bun.file(file).text()); } catch (e) { if (await Bun.file(file).exists()) { console.error(`cannot parse ${file}: ${e.message}`); process.exit(2); } }
    const keys = path.split("."); let o = root;
    for (const k of keys.slice(0, -1)) o = o[k] ??= {};
    o[keys.at(-1)] = JSON.parse(value);
    await Bun.write(file, JSON.stringify(root, null, 2) + "\n");
  ' "$1" "$2" "$3"
}
args_json=$(printf '%s\n' $ARGS | bun -e 'console.log(JSON.stringify((await Bun.stdin.text()).trim().split("\n")))')
cmd_json=$(printf '%s\n' $CMD $ARGS | bun -e 'console.log(JSON.stringify((await Bun.stdin.text()).trim().split("\n")))')
local_cfg="{\"type\":\"local\",\"command\":$cmd_json,\"enabled\":true}"
stdio_cfg="{\"type\":\"stdio\",\"command\":\"$CMD\",\"args\":$args_json}"
muse_cfg="{\"mode\":\"optional\",\"transport\":\"stdio\",\"command\":\"$CMD\",\"args\":$args_json}"

# 05 ───────────────────────────────────────────────────────────────────────────
step 05 "Registering the companion"
for agent in $CHOSEN; do
  case $agent in
    claude)
      if command -v claude >/dev/null; then
        [ "$TEST" = 1 ] || claude mcp remove -s user browspark >/dev/null 2>&1 || true
        run claude mcp add --transport stdio --scope user browspark -- $RUN >/dev/null && ok "Claude Code (user scope)"
      else
        warn "Claude Code CLI not found. Run later:  claude mcp add --transport stdio --scope user browspark -- $RUN"
      fi;;
    codex)
      if command -v codex >/dev/null; then
        [ "$TEST" = 1 ] || codex mcp remove browspark >/dev/null 2>&1 || true
        run codex mcp add browspark -- $RUN >/dev/null && ok "Codex (~/.codex/config.toml)"
      else
        f="$HOME/.codex/config.toml"; mkdir -p "$(dirname "$f")"
        if grep -q '^\[mcp_servers\.browspark\]' "$f" 2>/dev/null; then warn "Codex: browspark already in $f, left unchanged."
        else run bash -c "printf '\n[mcp_servers.browspark]\ncommand = \"%s\"\nargs = %s\n' '$CMD' '$args_json' >> '$f'"; ok "Codex ($f)"; fi
      fi;;
    opencode)
      f="$HOME/.config/opencode/opencode.json"
      run merge_json "$f" mcp.browspark "$local_cfg" && ok "OpenCode ($f)";;
    cursor)
      f="$HOME/.cursor/mcp.json"
      run merge_json "$f" mcpServers.browspark "$stdio_cfg" && ok "Cursor ($f)";;
    antigravity)
      warn "Antigravity: open Agent panel → … → MCP Servers → Manage → View raw config and add under \"mcpServers\":"
      dim "\"browspark\": {\"command\":\"$CMD\",\"args\":$args_json}";;
    muse)
      f="${XDG_CONFIG_HOME:-$HOME/.config}/muse/settings.json"
      if run merge_json "$f" mcpServers.browspark "$muse_cfg" && run bun -e '
        const [file] = process.argv.slice(1);
        let root = {};
        try { root = JSON.parse(await Bun.file(file).text()); } catch {}
        if (root.schema_version == null) { root = { schema_version: 1, ...root }; await Bun.write(file, JSON.stringify(root, null, 2) + "\n"); }
      ' "$f"; then ok "Muse Code ($f)"; fi;;
  esac
done

# 06 ───────────────────────────────────────────────────────────────────────────
step 06 "Connect your browsers"
dim "This download is for Chrome and Brave. Firefox and Zen use a separate extension build."
say "  1. Open ${B}chrome://extensions${X} or ${B}brave://extensions${X}, switch on ${B}Developer mode${X},"
say "     click ${B}Load unpacked${X} and pick ${G}$EXT_DIR${X}. Repeat for each browser profile."
say "  2. Click the Browspark toolbar icon. The dashboard connects to the companion on its own;"
say "     share the tabs your agent may use in each profile. All profiles use the same companion."
say "  3. Ask your agent to run ${B}browser_status${X}. Use the displayed browserId to choose where"
say "     new extension tabs open, or tabId to work in an existing tab."
say '  Firefox 153+ / compatible Zen: clone the repo and run bun install && bun run package.'
say '  In about:debugging, choose Load Temporary Add-on → dist/firefox-extension/manifest.json.'
say '  Register the source companion: command bun, argument the full path to companion/src/index.ts.'
say '  Open Browspark, enable user scripts, then share tabs. Reload after a browser restart.'
say '  Separate Firefox / Zen developer sessions still work without an extension.'
dim "Multiple browsers: https://docs.browspark.krishm.dev/reference/multiple-browsers"
dim "Firefox / Zen coverage: https://docs.browspark.krishm.dev/reference/firefox"
if [ "$TEST" = 1 ]; then printf '\n  %s●%s %sTest passed.%s Run without --test to apply.\n\n' "$G" "$X" "$B" "$X"
else printf '\n  %s●%s %sYou are good to go.%s  %shttps://docs.browspark.krishm.dev%s\n\n' "$G" "$X" "$B" "$X" "$D" "$X"; fi
