if (!globalThis.__instacinemaContentLoaded) {
  globalThis.__instacinemaContentLoaded = true;
  let running = false;

  function scrollTarget() {
    const candidates = [document.scrollingElement];
    for (const element of document.querySelectorAll("main, section, div")) {
      if (element.scrollHeight - element.clientHeight < 200) {
        continue;
      }
      const style = getComputedStyle(element);
      if (["auto", "scroll"].includes(style.overflowY)) {
        candidates.push(element);
      }
    }
    return candidates
      .filter(Boolean)
      .sort((left, right) => right.scrollHeight - left.scrollHeight)[0]
      || document.scrollingElement;
  }

  function scrollOnce() {
    const target = scrollTarget();
    const previousScrollHeight = target.scrollHeight;
    const previousScrollTop = target.scrollTop;
    // Trigger the feed's own infinite-scroll threshold on the element that
    // actually owns scrolling, then wait for the next request/DOM growth.
    target.scrollTop = target.scrollHeight;
    target.dispatchEvent(new Event("scroll", {bubbles: true}));
    return {
      ok: true,
      scrollY: target.scrollTop,
      scrollHeight: target.scrollHeight,
      previousScrollHeight,
      previousScrollTop,
      target: target === document.scrollingElement ? "document" : target.tagName,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "scroll") {
      sendResponse(scrollOnce());
    }
    if (message.type === "set-running") {
      running = message.running;
      sendResponse({ok: true});
    }
    return true;
  });
}
