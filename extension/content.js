// Content script: runs on YouTube pages
// Listens for messages from the popup

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_URL') {
    sendResponse({ url: window.location.href });
  }
});
