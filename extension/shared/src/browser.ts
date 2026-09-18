// Firefox's browser namespace returns promises for the same extension APIs.
export const api = ((globalThis as any).browser ?? globalThis.chrome) as typeof chrome;
export const isFirefox = typeof (api.runtime as any).getBrowserInfo === 'function';
// Firefox's background-tab screenshot API requires <all_urls> even for HTTP(S) tabs.
export const FIREFOX_PERMISSIONS: chrome.permissions.Permissions = { permissions: ['userScripts'], origins: ['<all_urls>'] };
