(() => {
  const originalOpen = window.open.bind(window);

  window.open = function(url, target, features) {
    let next = url;

    try {
      const parsed = new URL(String(url), location.href);
      const isChatGPT = parsed.hostname === "chatgpt.com" || parsed.hostname === "www.chatgpt.com";
      const isConversation = /^\/c\/[^/?#]+/.test(parsed.pathname);

      if (isChatGPT && isConversation) {
        parsed.hash = "notes-private";
        next = parsed.toString();
      }
    } catch (_) {}

    return originalOpen(next, target, features);
  };
})();
