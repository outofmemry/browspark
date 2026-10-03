// Like password managers do: embed an extension-owned iframe in ordinary pages, only when the page asks for it.
if (location.search.includes('inject-frame')) {
  const f = document.createElement('iframe');
  f.src = chrome.runtime.getURL('options.html');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:120px;height:60px;border:0';
  document.body.append(f);
}
