// background.js - Service worker for background operations and context menus

chrome.runtime.onInstalled.addListener(() => {
  // Create context menu item
  chrome.contextMenus.create({
    id: "sendToN8N",
    title: "Send selected text to n8n as Lead",
    contexts: ["selection", "page"]
  });
  console.log("leadgen extension installed and context menus created.");
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "sendToN8N") {
    // Get stored webhook URL
    chrome.storage.local.get(["webhookUrl"], (result) => {
      const webhookUrl = result.webhookUrl;
      if (!webhookUrl) {
        console.warn("No webhook URL configured. Please open the extension popup and configure the webhook URL.");
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icon.png", 
          title: "leadgen",
          message: "Please configure your n8n Webhook URL in the extension popup first!",
          priority: 2
        });
        return;
      }

      // Prepare lead data
      const leadData = {
        name: info.selectionText || "N/A",
        sourceUrl: info.pageUrl,
        title: tab ? tab.title : "N/A",
        notes: `Extracted via context menu. Selection: ${info.selectionText || "None"}`,
        extractedAt: new Date().toISOString()
      };

      // Send to webhook
      fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(leadData)
      })
      .then(response => {
        if (response.ok) {
          chrome.notifications.create({
            type: "basic",
            title: "Lead Sent Successfully",
            message: `Lead has been sent to n8n.`,
            priority: 1
          });
        } else {
          throw new Error(`Server responded with status: ${response.status}`);
        }
      })
      .catch(error => {
        console.error("Failed to send lead to n8n:", error);
        chrome.notifications.create({
          type: "basic",
          title: "Lead Submission Failed",
          message: `Error: ${error.message}`,
          priority: 2
        });
      });
    });
  }
});
