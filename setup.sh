#!/usr/bin/env bash
# Browspark setup: downloads the extension and registers the companion with your agent.
#   curl -fsSL https://browspark.krishm.dev/setup.sh | bash
#   bash setup.sh --test   # dry run: no download, writes no config
set -euo pipefail

TEST=0; [ "${1:-}" = "--test" ] && TEST=1

CHROME_ZIP_URL="${BROWSPARK_ZIP_URL:-https://github.com/outofmemry/browspark/releases/latest/download/browspark-chrome-extension.zip}"
FIREFOX_ZIP_URL="${BROWSPARK_FIREFOX_ZIP_URL:-https://github.com/outofmemry/browspark/releases/latest/download/browspark-firefox-extension.zip}"
CHROME_DIR="$HOME/browspark-extension"
FIREFOX_DIR="$HOME/browspark-firefox-extension"
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
ask()  { printf '  %s›%s %s ' "$G" "$X" "$1" >&2; local reply=; read -r reply < /dev/tty || true; printf '%s' "$reply"; }
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
step 02 "Choose your browser extension"
dim "1) Chrome (Chromium)"
dim "2) Firefox (Gecko)"
dim "3) Both"
b=${BROWSPARK_BROWSERS:-$(ask "Choice [1]:")}
b=${b:-1}
RAW=""
for n in $b; do
  case "$n" in
    1) RAW="$RAW chrome";;
    2) RAW="$RAW firefox";;
    3|all) RAW="$RAW chrome firefox";;
  esac
done
BROWSERS=""
for m in $RAW; do case " $BROWSERS " in *" $m "*) ;; *) BROWSERS="$BROWSERS $m";; esac; done
BROWSERS=${BROWSERS# }
[ -n "$BROWSERS" ] || fail "No browser selected."
download_ext() { # label url dir
  if [ "$TEST" = 1 ]; then
    dim "would download: $2"
    dim "would unzip to:  $3"
  else
    dim "Downloading $1..."
    tmp=$(mktemp -t browspark.XXXXXX)
    trap 'rm -f "$tmp"' EXIT
    if [ -t 2 ]; then progress="--progress-bar"; else progress="-sS"; fi
    # shellcheck disable=SC2086
    curl -fSL $progress --connect-timeout 20 --max-time 300 --retry 2 "$2" -o "$tmp" || fail "Download failed: $2"
    dim "Unpacking $1..."
    rm -rf "$3" && mkdir -p "$3" && unzip -qo "$tmp" -d "$3"
    [ -f "$3/manifest.json" ] || fail "The archive did not contain an extension."
    ok "Saved $1 to $3"
  fi
}
for m in $BROWSERS; do
  case $m in
    chrome) download_ext "Chromium extension" "$CHROME_ZIP_URL" "$CHROME_DIR";;
    firefox) download_ext "Firefox extension" "$FIREFOX_ZIP_URL" "$FIREFOX_DIR";;
  esac
done

# 03 ───────────────────────────────────────────────────────────────────────────
step 03 "Choose how to run the companion"
dim "1) bun    bunx $PKG"
dim "2) pnpm   pnpm dlx $PKG"
dim "3) npm    npx -y $PKG"
a=${BROWSPARK_PKG:-$(ask "Package manager [1]:")}
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
AGENTS="claude codex opencode cursor antigravity muse hermes other"
i=0; for n in $AGENTS; do i=$((i+1)); dim "$i) $n"; done
a=${BROWSPARK_AGENTS:-$(ask "Numbers separated by spaces, or 'all' [1]:")}
a=${a:-1}
[ "$a" = all ] && a="1 2 3 4 5 6 7"
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
    hermes)
      # Hermes reads MCP servers from ~/.hermes/config.yaml under mcp_servers.
      f="$HOME/.hermes/config.yaml"
      if grep -q '^[[:space:]]*browspark:' "$f" 2>/dev/null; then warn "Hermes: browspark already in $f, left unchanged."
      elif run bun -e '
        const [file, cmd, argsJson] = process.argv.slice(1);
        const entry = `  browspark:\n    command: ${JSON.stringify(cmd)}\n    args: ${argsJson}\n`;
        let text = "";
        try { text = await Bun.file(file).text(); } catch (e) { if (await Bun.file(file).exists()) throw e; }
        if (/^[ \t]*browspark:/m.test(text)) { console.error(`browspark already in ${file}`); process.exit(3); }
        if (/^mcp_servers:[ \t]*$/m.test(text)) {
          text = text.replace(/^mcp_servers:[ \t]*$/m, "mcp_servers:\n" + entry.trimEnd());
        } else if (/^mcp_servers:/m.test(text)) {
          console.error(`non-standard mcp_servers block in ${file}; add the entry by hand`);
          process.exit(4);
        } else {
          if (text && !text.endsWith("\n")) text += "\n";
          text += "mcp_servers:\n" + entry;
        }
        await Bun.write(file, text);
      ' "$f" "$CMD" "$args_json"; then ok "Hermes ($f)"; else warn "Hermes: left $f unchanged; add browspark under mcp_servers: by hand."; fi;;
    other)
      dim "Other: add to your client's MCP config:"
      dim "  $RUN";;
  esac
done

# 06 ───────────────────────────────────────────────────────────────────────────
step 06 "Connect your browsers"
for m in $BROWSERS; do
  case $m in
    chrome)
      say "  ${B}Chromium:${X} ${B}chrome://extensions${X} → Developer mode → Load unpacked → ${G}$CHROME_DIR${X}.";;
    firefox)
      say "  ${B}Firefox / Zen:${X} ${B}about:debugging${X} → Load Temporary Add-on → ${G}$FIREFOX_DIR/manifest.json${X} (reload after restart).";;
  esac
done
say "  Share tabs in the Browspark dashboard, then ask your agent for ${B}browser_status${X}."
dim "Docs: https://docs.browspark.krishm.dev"
if [ "$TEST" = 1 ]; then printf '\n  %s●%s %sTest passed.%s Run without --test to apply.\n\n' "$G" "$X" "$B" "$X"
else printf '\n  %s●%s %sYou are good to go.%s  %shttps://docs.browspark.krishm.dev%s\n\n' "$G" "$X" "$B" "$X" "$D" "$X"; fi
