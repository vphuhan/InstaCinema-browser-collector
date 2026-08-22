const stopButton = document.querySelector("#stop");
const status = document.querySelector("#status");

function send(message) {
  chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) {
      status.textContent = chrome.runtime.lastError.message;
      return;
    }
    status.textContent = response?.message ?? "No response";
    if (response?.running !== undefined) {
      stopButton.disabled = !response.running;
    }
  });
}

stopButton.addEventListener("click", () => send({type: "stop"}));
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "status") {
    status.textContent = message.message;
  }
});

// Opening the extension popup is the user's explicit Start action.
send({type: "start"});
