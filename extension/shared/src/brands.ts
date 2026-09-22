type GraphBrand = { name: string; label: string; src: string; darkSrc?: string };

// Tuple: [pattern, product name, logo, dark logo?, display label?]. The display
// label defaults to the reported name; set it when the reported name is an
// internal codename with no user-facing meaning (e.g. tbh -> Muse Code).
const brands: Record<'agent' | 'browser', [RegExp, string, string, string?, string?][]> = {
  agent: [
    [/^claude(?:[\s_/-]|$)/i, 'Claude', 'clients/claude.png'],
    [/^(?:openai[\s_-])?codex(?:[\s_/-]|$)/i, 'Codex', 'clients/codex.svg'],
    [/^cursor(?:[\s_/-]|$)/i, 'Cursor', 'clients/cursor.svg', 'clients/cursor-dark.svg'],
    [/^open[\s_-]?code(?:[\s_/-]|$)/i, 'OpenCode', 'clients/opencode.svg', 'clients/opencode-dark.svg'],
    [/^(?:google[\s_-])?antigravity(?:[\s_/-]|$)/i, 'Antigravity', 'clients/antigravity.png'],
    [/^(?:meta[\s_-])?muse(?:[\s_-]?(?:code|spark))?(?:[\s_/-]|$)/i, 'Muse Code', 'clients/muse.svg'],
    [/^tbh(?:$|[:\s_./-])/i, 'Muse Code', 'clients/muse.svg', undefined, 'Muse Code'],
  ],
  browser: [
    [/^(?:google\s+)?chrome(?:[\s/]|$)/i, 'Chrome', 'browsers/chrome.svg'],
    [/^chromium(?:[\s/]|$)/i, 'Chromium', 'browsers/chromium.png'],
    [/^(?:microsoft\s+)?edg(?:e|a|ios)?(?:[\s/]|$)/i, 'Edge', 'browsers/edge.svg'],
    [/^brave(?:[\s/]|$)/i, 'Brave', 'browsers/brave.svg'],
    [/^helium(?:[\s/]|$)/i, 'Helium', 'browsers/helium.svg'],
    [/^vivaldi(?:[\s/]|$)/i, 'Vivaldi', 'browsers/vivaldi.png'],
    [/^arc(?:[\s/]|$)/i, 'Arc', 'browsers/arc.svg'],
    [/^dia(?:[\s/]|$)/i, 'Dia', 'browsers/dia.png'],
    [/^(?:mozilla\s+)?firefox(?:[\s/]|$)/i, 'Firefox', 'browsers/firefox.png'],
    [/^tor(?:[\s/]|$)/i, 'Tor', 'browsers/tor.svg'],
    [/^zen(?:[\s/]|$)/i, 'Zen', 'browsers/zen.svg'],
  ],
};

/**
 * Reported browser name for the connection graph. Chromium forks often keep
 * "Google Chrome" in client hints for compatibility, so UA tokens win over
 * brands; unidentified browsers fall through to brands/undefined and the
 * dashboard shows the Chromium/Firefox fallback logo by engine.
 */
export function detectBrowserName(brands: { brand: string; version: string }[], ua: string, info?: { name: string; version: string }): string | undefined {
  if (info) {
    if (/zen/i.test(ua) || /zen/i.test(info.name)) return `Zen ${/Zen\/([\d.]+)/i.exec(ua)?.[1] ?? info.version}`.trim();
    return `${info.name} ${info.version}`.trim();
  }
  const has = (re: RegExp) => brands.some((b) => re.test(b.brand));
  const ver = (re: RegExp) => re.exec(ua)?.[1];
  const brandVer = (re: RegExp) => brands.find((b) => re.test(b.brand))?.version;
  const edge = ver(/Edg(?:e|A|iOS)?\/([\d.]+)/i);
  if (edge || has(/edge/i)) return `Microsoft Edge ${edge ?? brandVer(/edge/i) ?? ''}`.trim();
  const vivaldi = ver(/Vivaldi\/([\d.]+)/i);
  if (vivaldi || has(/vivaldi/i)) return `Vivaldi ${vivaldi ?? brandVer(/vivaldi/i) ?? ''}`.trim();
  if (/helium/i.test(ua) || has(/helium/i)) return `Helium ${ver(/Helium\/([\d.]+)/i) ?? brandVer(/helium/i) ?? ver(/Chrome\/([\d.]+)/) ?? ''}`.trim();
  const dia = ver(/Dia\/([\d.]+)/i);
  if (dia || has(/\bdia\b/i)) return `Dia ${dia ?? brandVer(/\bdia\b/i) ?? ''}`.trim();
  const arc = ver(/Arc\/([\d.]+)/i);
  if (arc || has(/\barc\b/i)) return `Arc ${arc ?? brandVer(/\barc\b/i) ?? ''}`.trim();
  if (has(/brave/i) || /Brave\/([\d.]+)/i.test(ua)) return `Brave ${brandVer(/brave/i) ?? ver(/Brave\/([\d.]+)/i) ?? ''}`.trim();
  const named = brands.find((b) => !/Chromium|not.*brand/i.test(b.brand)) ?? brands.find((b) => /Chromium/.test(b.brand));
  return named ? `${named.brand} ${named.version}` : undefined;
}

/** Dropdown options shown per engine in Settings. */
export const labelOptions = (engine: 'chromium' | 'firefox'): string[] => engine === 'firefox'
  ? ['Firefox', 'Tor', 'Zen', 'Other']
  : ['Chrome', 'Edge', 'Brave', 'Helium', 'Vivaldi', 'Arc', 'Dia', 'Chromium', 'Other'];

/** Labels the Settings dropdown may store (blank is Auto). */
export const isKnownLabel = (name: string): boolean => name === '' || /^(?:chrome|chromium|edge|brave|helium|vivaldi|arc|dia|firefox|tor|zen|other)$/i.test(name);

/** Manual Settings override wins; blank falls back to automatic detection, Other to the engine's generic name. */
export function resolveBrowserName(custom: string | undefined, brands: { brand: string; version: string }[], ua: string, info?: { name: string; version: string }, engine: 'chromium' | 'firefox' = 'chromium'): string | undefined {
  const picked = custom?.trim();
  if (picked?.toLowerCase() === 'other') return engine === 'firefox' ? 'Firefox' : 'Chromium';
  return picked || detectBrowserName(brands, ua, info);
}

// Match reported products; unidentified browsers get their engine's mark.
export function graphBrand(name: string, kind: 'agent' | 'browser', engine?: 'chromium' | 'firefox'): GraphBrand {
  const match = brands[kind].find(([pattern]) => pattern.test(name.trim()));
  if (match) return { name: match[1], label: match[4] ?? name.trim(), src: `assets/${match[2]}`, ...(match[3] ? { darkSrc: `assets/${match[3]}` } : {}) };
  if (kind === 'agent') return { name: 'Other agent', label: 'Other agent', src: 'assets/clients/other-agent.svg' };
  // Older companions omit engine metadata; retain their Firefox-based name hint.
  const firefox = engine ? engine === 'firefox' : /^(?:mozilla\s+)?firefox\b/i.test(name.trim());
  const label = firefox ? 'Unknown Firefox' : 'Unknown Chromium';
  return { name: label, label, src: firefox ? 'assets/browsers/firefox.png' : 'assets/browsers/chromium.png' };
}
