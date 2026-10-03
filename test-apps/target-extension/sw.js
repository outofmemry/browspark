// Cooperating extension: replies to any extension that messages it (no externally_connectable restriction).
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  sendResponse({ echo: message, from: sender.id });
});
