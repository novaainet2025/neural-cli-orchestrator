export async function activeTab(requestedTabId) {
  if (typeof requestedTabId === 'number') return chrome.tabs.get(requestedTabId);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
