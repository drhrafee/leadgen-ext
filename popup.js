// popup.js - Scraper control panel and CSV downloader logic

document.addEventListener("DOMContentLoaded", () => {
  // Elements
  const tabBtns = document.querySelectorAll(".tab-btn");
  const tabViews = document.querySelectorAll(".tab-view");
  
  const btnScrape = document.getElementById("btn-scrape");
  const btnScrapeText = document.getElementById("btn-scrape-text");
  const btnExportCsv = document.getElementById("btn-export-csv");
  const scrapeSpinner = document.getElementById("scrape-spinner");
  const leadsCount = document.getElementById("leads-count");
  
  const previewBody = document.getElementById("preview-body");
  
  const progressContainer = document.getElementById("progress-container");
  const progressLabel = document.getElementById("progress-label");
  const progressPercentage = document.getElementById("progress-percentage");
  const progressBar = document.getElementById("progress-bar");

  const chkAutoScroll = document.getElementById("chk-auto-scroll");
  const numScrollLimit = document.getElementById("num-scroll-limit");
  
  const integrationForm = document.getElementById("integration-form");
  const settingsWebhook = document.getElementById("settings-webhook");
  const btnPushN8N = document.getElementById("btn-push-n8n");
  const webhookStatusDot = document.getElementById("webhook-status-dot");
  const webhookStatusText = document.getElementById("webhook-status-text");
  
  const toast = document.getElementById("toast");

  // State
  let currentLeads = [];
  let storedWebhookUrl = "";

  // 1. Tab Switching
  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetTab = btn.getAttribute("data-tab");
      
      tabBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      
      tabViews.forEach(view => {
        if (view.id === `tab-view-${targetTab}`) {
          view.classList.add("active");
        } else {
          view.classList.remove("active");
        }
      });
    });
  });

  // 2. Load Stored Integration Webhook & Cached Leads
  chrome.storage.local.get(["webhookUrl", "lastScrapedLeads"], (result) => {
    if (result.webhookUrl) {
      storedWebhookUrl = result.webhookUrl;
      settingsWebhook.value = storedWebhookUrl;
      updateWebhookStatus(true);
    } else {
      updateWebhookStatus(false);
    }

    if (result.lastScrapedLeads && result.lastScrapedLeads.length > 0) {
      currentLeads = result.lastScrapedLeads;
      leadsCount.textContent = currentLeads.length;
      renderPreviewTable(currentLeads);
      btnExportCsv.disabled = false;
      if (storedWebhookUrl) {
        btnPushN8N.disabled = false;
      }
    }
  });

  function updateWebhookStatus(configured) {
    if (configured) {
      webhookStatusDot.classList.add("active");
      webhookStatusText.textContent = "n8n Webhook Connected";
      webhookStatusText.style.color = "var(--success-color)";
      if (currentLeads.length > 0) {
        btnPushN8N.disabled = false;
      }
    } else {
      webhookStatusDot.classList.remove("active");
      webhookStatusText.textContent = "Webhook URL not configured";
      webhookStatusText.style.color = "var(--text-muted)";
      btnPushN8N.disabled = true;
    }
  }

  // Save integration webhook
  integrationForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const url = settingsWebhook.value.trim();
    chrome.storage.local.set({ webhookUrl: url }, () => {
      storedWebhookUrl = url;
      updateWebhookStatus(!!url);
      showToast(url ? "Webhook configured!" : "Webhook configuration cleared.", "success");
    });
  });

  // 3. Scrape current page
  btnScrape.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) return;
      const activeTab = tabs[0];
      const tabUrl = activeTab.url || "";

      // Validate URL context
      if (!tabUrl.includes("google.com") && !tabUrl.includes("google.co")) {
        showToast("Open Google Search or Maps first!", "error");
        return;
      }

      // Read auto-scroll options
      const autoScroll = chkAutoScroll.checked;
      const maxResults = parseInt(numScrollLimit.value, 10) || 50;

      // Start UI Loading State
      btnScrape.disabled = true;
      scrapeSpinner.classList.remove("hidden");
      btnScrapeText.textContent = autoScroll ? "Scrolling & Scraping..." : "Scraping page...";

      // Inject Content Script dynamically to ensure it runs
      chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ["content.js"]
      })
      .then(() => {
        // Send scrape request message
        chrome.tabs.sendMessage(
          activeTab.id, 
          { action: "scrapeCurrentPage", autoScroll: autoScroll, maxResults: maxResults }, 
          (response) => {
            btnScrape.disabled = false;
            scrapeSpinner.classList.add("hidden");
            btnScrapeText.textContent = "Scrape Current Page";

            if (chrome.runtime.lastError) {
              console.error("Communication error:", chrome.runtime.lastError.message);
              showToast("Scrape failed: Refresh page and try again.", "error");
              return;
            }

            if (response && response.listings) {
              // Initialize leads with Email = N/A
              currentLeads = response.listings.map(lead => ({
                ...lead,
                email: "N/A"
              }));
              leadsCount.textContent = currentLeads.length;
              
              // Render Table Preview
              renderPreviewTable(currentLeads);
              
              if (currentLeads.length > 0) {
                const hasWebsites = currentLeads.some(lead => lead.website && lead.website !== "N/A" && lead.website.trim() !== "");
                
                if (hasWebsites) {
                  // Launch deep website scraping
                  deepScrapeAllWebsites(currentLeads);
                } else {
                  // Save to storage cache immediately
                  chrome.storage.local.set({ lastScrapedLeads: currentLeads });
                  btnExportCsv.disabled = false;
                  if (storedWebhookUrl) {
                    btnPushN8N.disabled = false;
                  }
                  showToast(`Scraped ${currentLeads.length} leads (no websites to crawl).`, "success");
                }
              } else {
                btnExportCsv.disabled = true;
                btnPushN8N.disabled = true;
                showToast("No listings detected on this page.", "error");
              }
            }
          }
        );
      })
      .catch(err => {
        console.error("Execution injection error:", err);
        btnScrape.disabled = false;
        scrapeSpinner.classList.add("hidden");
        btnScrapeText.textContent = "Scrape Current Page";
        showToast("Error scanning page content.", "error");
      });
    });
  });

  // 4. Render Listings Preview Table
  function renderPreviewTable(listings) {
    previewBody.innerHTML = "";
    
    if (listings.length === 0) {
      const row = document.createElement("tr");
      row.className = "empty-row";
      row.innerHTML = `<td colspan="4">No leads scraped yet. Open Google Maps or Search results and click Scrape.</td>`;
      previewBody.appendChild(row);
      return;
    }

    listings.forEach((lead, index) => {
      const row = document.createElement("tr");
      row.setAttribute("data-index", index);
      
      const tdName = document.createElement("td");
      tdName.textContent = lead.name;
      tdName.title = lead.name;
      
      const tdPhone = document.createElement("td");
      tdPhone.textContent = lead.phone;
      tdPhone.title = lead.phone;

      const tdEmail = document.createElement("td");
      tdEmail.textContent = lead.email || "N/A";
      tdEmail.title = lead.email || "N/A";
      tdEmail.className = "lead-email-cell";
      
      const tdWeb = document.createElement("td");
      tdWeb.textContent = lead.website;
      tdWeb.title = lead.website;
      
      row.appendChild(tdName);
      row.appendChild(tdPhone);
      row.appendChild(tdEmail);
      row.appendChild(tdWeb);
      previewBody.appendChild(row);
    });
  }

  // Update specific row cell in real time
  function updatePreviewRow(index, email) {
    const row = previewBody.querySelector(`tr[data-index="${index}"]`);
    if (row) {
      const emailCell = row.querySelector(".lead-email-cell");
      if (emailCell) {
        emailCell.textContent = email;
        emailCell.title = email;
      }
    }
  }

  // Handle live progress bar updates
  function updateProgressBar(current, total) {
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    progressBar.style.width = `${percent}%`;
    progressPercentage.textContent = `${percent}%`;
    progressLabel.textContent = `Deep-scraping websites: ${current} of ${total}`;
  }

  // Parallel website scraping with concurrency pool
  async function deepScrapeAllWebsites(leads) {
    const scrapeQueue = [];
    leads.forEach((lead, index) => {
      if (lead.website && lead.website !== "N/A" && lead.website.trim() !== "") {
        scrapeQueue.push({ lead, index });
      }
    });

    if (scrapeQueue.length === 0) return;

    // UI state updates
    progressContainer.classList.remove("hidden");
    updateProgressBar(0, scrapeQueue.length);

    btnExportCsv.disabled = true;
    btnPushN8N.disabled = true;
    btnScrape.disabled = true;

    const CONCURRENCY_LIMIT = 4;
    let completedCount = 0;
    const totalCount = scrapeQueue.length;

    async function worker() {
      while (scrapeQueue.length > 0) {
        const item = scrapeQueue.shift();
        if (!item) continue;

        const { lead, index } = item;
        try {
          updatePreviewRow(index, "Scraping...");
          
          const result = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
              { action: "scrapeWebsiteDetails", url: lead.website },
              (res) => {
                if (chrome.runtime.lastError) {
                  console.warn("Background communication error:", chrome.runtime.lastError.message);
                  resolve({ email: "N/A", socialMedia: "N/A" });
                } else {
                  resolve(res || { email: "N/A", socialMedia: "N/A" });
                }
              }
            );
          });

          lead.email = result.email || "N/A";
          
          if (result.socialMedia && result.socialMedia !== "N/A") {
            if (lead.socialMedia === "N/A") {
              lead.socialMedia = result.socialMedia;
            } else {
              const merged = Array.from(new Set([
                ...lead.socialMedia.split(", ").map(s => s.trim()),
                ...result.socialMedia.split(", ").map(s => s.trim())
              ])).join(", ");
              lead.socialMedia = merged;
            }
          }

          updatePreviewRow(index, lead.email);
        } catch (err) {
          console.error("Scraping queue error", index, err);
          lead.email = "N/A";
          updatePreviewRow(index, "N/A");
        } finally {
          completedCount++;
          updateProgressBar(completedCount, totalCount);
        }
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY_LIMIT, totalCount); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    progressLabel.textContent = "Website scraping complete!";
    
    // Save to storage cache
    chrome.storage.local.set({ lastScrapedLeads: leads });

    // Enable export actions
    btnExportCsv.disabled = false;
    if (storedWebhookUrl) {
      btnPushN8N.disabled = false;
    }
    btnScrape.disabled = false;

    showToast(`Scrape complete! Found emails for listings.`, "success");

    setTimeout(() => {
      progressContainer.classList.add("hidden");
    }, 2000);
  }

  // 5. CSV Export and Download Helper
  btnExportCsv.addEventListener("click", () => {
    if (currentLeads.length === 0) return;

    // Helper to escape values for CSV compatibility and remove line breaks
    function escapeCSV(str) {
      if (str === null || str === undefined) return "N/A";
      // Replace newlines with spaces to avoid vertical height expanding in Excel/Spreadsheets
      const s = String(str).trim().replace(/[\r\n]+/g, " ");
      if (s.includes(",") || s.includes('"')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s || "N/A";
    }

    // CSV Headers
    const headers = ["Name", "Location", "Google Maps Link", "Phone Number", "Email", "Website", "Social Media"];
    
    // Build Rows
    const csvRows = [headers.join(",")];
    currentLeads.forEach(lead => {
      const rowValues = [
        escapeCSV(lead.name),
        escapeCSV(lead.location),
        escapeCSV(lead.mapsLink),
        escapeCSV(lead.phone),
        escapeCSV(lead.email),
        escapeCSV(lead.website),
        escapeCSV(lead.socialMedia)
      ];
      csvRows.push(rowValues.join(","));
    });

    // Create File Blob
    const csvContent = "\uFEFF" + csvRows.join("\n"); // Add BOM for UTF-8 compatibility in Excel
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    
    // Download Trigger
    const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `leadgen_export_${timestamp}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showToast("CSV file exported successfully!", "success");
  });

  // 6. Push to n8n Webhook
  btnPushN8N.addEventListener("click", () => {
    if (!storedWebhookUrl || currentLeads.length === 0) return;

    btnPushN8N.disabled = true;
    showToast("Pushing leads to n8n...", "success");

    fetch(storedWebhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        source: "leadgen Chrome Extension",
        scrapedAt: new Date().toISOString(),
        totalLeads: currentLeads.length,
        leads: currentLeads
      })
    })
    .then(response => {
      if (!response.ok) {
        throw new Error(`n8n responded with status ${response.status}`);
      }
      showToast(`Pushed ${currentLeads.length} leads to n8n!`, "success");
    })
    .catch(error => {
      console.error("n8n Push Error:", error);
      showToast("Push failed: check network/URL config.", "error");
    })
    .finally(() => {
      btnPushN8N.disabled = false;
    });
  });

  // Toast System
  function showToast(message, type = "success") {
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    
    setTimeout(() => {
      toast.classList.remove("show");
    }, 3000);
  }
});
