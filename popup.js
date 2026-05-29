// popup.js - Scraper control panel and CSV downloader logic

document.addEventListener("DOMContentLoaded", () => {
  // Elements
  const btnScrape = document.getElementById("btn-scrape");
  const btnScrapeText = document.getElementById("btn-scrape-text");
  const btnStop = document.getElementById("btn-stop");
  const btnStopText = document.getElementById("btn-stop-text");
  const btnExportCsv = document.getElementById("btn-export-csv");
  const btnClearHistory = document.getElementById("btn-clear-history");
  const scrapeSpinner = document.getElementById("scrape-spinner");
  const leadsCount = document.getElementById("leads-count");
  
  const previewBody = document.getElementById("preview-body");
  
  const progressContainer = document.getElementById("progress-container");
  const progressLabel = document.getElementById("progress-label");
  const progressPercentage = document.getElementById("progress-percentage");
  const progressBar = document.getElementById("progress-bar");

  const chkAutoScroll = document.getElementById("chk-auto-scroll");
  const numScrollLimit = document.getElementById("num-scroll-limit");
  
  const toast = document.getElementById("toast");

  // State
  let currentLeads = [];
  let activeTabId = null;
  let currentPhase = "idle"; // "idle", "scrolling", "crawling"
  let shouldStopDeepScraping = false;
  let userStoppedScraping = false;

  function resetScraperState() {
    currentPhase = "idle";
    shouldStopDeepScraping = false;
    btnScrape.disabled = false;
    btnStop.disabled = true;
    btnStopText.textContent = "Stop";
    scrapeSpinner.classList.add("hidden");
    btnScrapeText.textContent = "Start";
  }

  // Load Cached Leads
  chrome.storage.local.get(["lastScrapedLeads"], (result) => {
    if (result.lastScrapedLeads && result.lastScrapedLeads.length > 0) {
      currentLeads = result.lastScrapedLeads;
      leadsCount.textContent = currentLeads.length;
      renderPreviewTable(currentLeads);
      btnExportCsv.disabled = false;
      btnClearHistory.disabled = false;
    }
  });

  // 3. Scrape current page
  btnScrape.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) return;
      const activeTab = tabs[0];
      const tabUrl = activeTab.url || "";
      activeTabId = activeTab.id;

      // Validate URL context
      if (!tabUrl.includes("google.com") && !tabUrl.includes("google.co")) {
        showToast("Open Google Search or Maps first!", "error");
        return;
      }

      // Read auto-scroll options
      const autoScroll = chkAutoScroll.checked;
      const maxResults = parseInt(numScrollLimit.value, 10) || 50;

      // Start UI Loading State
      currentPhase = "scrolling";
      btnScrape.disabled = true;
      btnStop.disabled = false;
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
            if (chrome.runtime.lastError) {
              console.error("Communication error:", chrome.runtime.lastError.message);
              resetScraperState();
              showToast("Scrape failed: Refresh page and try again.", "error");
              return;
            }
            // Message sent successfully, background work will send scrapingComplete
          }
        );
      })
      .catch(err => {
        console.error("Execution injection error:", err);
        resetScraperState();
        showToast("Error scanning page content.", "error");
      });
    });
  });

  // 3.5. Stop active scraping or crawling
  btnStop.addEventListener("click", () => {
    if (currentPhase === "scrolling") {
      userStoppedScraping = true;
      btnStop.disabled = true;
      btnStopText.textContent = "Stopping...";
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || !tabs[0]) return;
        const activeTab = tabs[0];
        
        chrome.tabs.sendMessage(activeTab.id, { action: "stopScraping" }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn("Stop command failed:", chrome.runtime.lastError.message);
            resetScraperState();
          }
        });
      });
    } else if (currentPhase === "crawling") {
      shouldStopDeepScraping = true;
      
      // Stop crawling phase immediately from UI perspective to avoid 6s timeouts lag
      progressLabel.textContent = "Website scraping stopped.";
      showToast("Scraping stopped by user.", "error");
      
      resetScraperState();
      
      // Update any remaining items in view to Offline or N/A
      currentLeads.forEach((lead) => {
        if (lead.websiteStatus === "Verifying..." || lead.websiteStatus === "Scraping...") {
          lead.websiteStatus = "Offline";
          lead.email = "N/A";
        }
      });
      renderPreviewTable(currentLeads);
      
      // Save current progress to local storage
      chrome.storage.local.set({ lastScrapedLeads: currentLeads });
      
      btnExportCsv.disabled = false;
      btnClearHistory.disabled = false;
      
      setTimeout(() => {
        progressContainer.classList.add("hidden");
      }, 1500);
    }
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
      tdWeb.className = "lead-web-cell";
      
      const website = lead.website || "N/A";
      if (website && website !== "N/A" && website.trim() !== "") {
        let href = website.trim();
        if (!/^https?:\/\//i.test(href)) {
          href = "https://" + href;
        }
        
        const link = document.createElement("a");
        link.className = "lead-web-link";
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        if (website.includes("aclk") || website.includes("googleadservices.com")) {
          link.textContent = "Resolving ad website...";
        } else {
          link.textContent = website;
        }
        link.title = website;
        tdWeb.appendChild(link);
        
        // Render badge if status is present and not Healthy or N/A
        const status = lead.websiteStatus;
        if (status && status !== "Healthy" && status !== "N/A") {
          const badge = document.createElement("span");
          badge.className = "web-status-badge";
          if (status === "Verifying...") {
            badge.classList.add("verifying");
            badge.textContent = "⏳";
            badge.title = "Verifying...";
          } else {
            badge.classList.add("broken");
            badge.textContent = status;
            badge.title = status;
          }
          tdWeb.appendChild(badge);
        }
      } else {
        tdWeb.textContent = "N/A";
        tdWeb.title = "N/A";
      }
      
      row.appendChild(tdName);
      row.appendChild(tdPhone);
      row.appendChild(tdEmail);
      row.appendChild(tdWeb);
      previewBody.appendChild(row);
    });
  }

  // Update specific row cell in real time (email, website status badge, and website URL)
  function updatePreviewRowData(index, email, status, websiteUrl) {
    const row = previewBody.querySelector(`tr[data-index="${index}"]`);
    if (row) {
      const emailCell = row.querySelector(".lead-email-cell");
      if (emailCell) {
        emailCell.textContent = email;
        emailCell.title = email;
      }
      
      const webCell = row.querySelector(".lead-web-cell");
      if (webCell) {
        if (websiteUrl && websiteUrl !== "N/A" && websiteUrl.trim() !== "") {
          let link = webCell.querySelector(".lead-web-link");
          if (!link) {
            webCell.innerHTML = ""; // Clear N/A text
            link = document.createElement("a");
            link.className = "lead-web-link";
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            webCell.appendChild(link);
          }
          link.href = websiteUrl.trim();
          let displayUrl = websiteUrl.trim();
          if (displayUrl.includes("aclk") || displayUrl.includes("googleadservices.com")) {
            displayUrl = "Resolving ad website...";
          }
          link.textContent = displayUrl;
          link.title = websiteUrl.trim();
        } else if (websiteUrl === "N/A") {
          webCell.textContent = "N/A";
          webCell.title = "N/A";
        }

        // Remove existing badge
        const oldBadge = webCell.querySelector(".web-status-badge");
        if (oldBadge) {
          oldBadge.remove();
        }
        
        // Add new badge if appropriate
        if (status && status !== "Healthy" && status !== "N/A") {
          const badge = document.createElement("span");
          badge.className = "web-status-badge";
          if (status === "Verifying...") {
            badge.classList.add("verifying");
            badge.textContent = "⏳";
            badge.title = "Verifying...";
          } else {
            badge.classList.add("broken");
            badge.textContent = status;
            badge.title = status;
          }
          webCell.appendChild(badge);
        }
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
        // Set initial status to Verifying...
        lead.websiteStatus = "Verifying...";
        updatePreviewRowData(index, "Scraping...", "Verifying...", lead.website);
      } else {
        lead.websiteStatus = "N/A";
      }
    });

    if (scrapeQueue.length === 0) return;

    shouldStopDeepScraping = false;

    // UI state updates
    progressContainer.classList.remove("hidden");
    updateProgressBar(0, scrapeQueue.length);

    btnExportCsv.disabled = true;
    btnClearHistory.disabled = true;
    btnScrape.disabled = true;
    btnStop.disabled = false;

    const CONCURRENCY_LIMIT = 4;
    let completedCount = 0;
    const totalCount = scrapeQueue.length;

    async function worker() {
      while (scrapeQueue.length > 0) {
        if (shouldStopDeepScraping) {
          break;
        }

        const item = scrapeQueue.shift();
        if (!item) continue;

        const { lead, index } = item;
        try {
          updatePreviewRowData(index, "Scraping...", "Verifying...", lead.website);
          
          const result = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
              { action: "scrapeWebsiteDetails", url: lead.website },
              (res) => {
                if (chrome.runtime.lastError) {
                  console.warn("Background communication error:", chrome.runtime.lastError.message);
                  resolve({ email: "N/A", socialMedia: "N/A", websiteStatus: "Offline" });
                } else {
                  resolve(res || { email: "N/A", socialMedia: "N/A", websiteStatus: "Offline" });
                }
              }
            );
          });

          lead.email = result.email || "N/A";
          lead.websiteStatus = result.websiteStatus || "Healthy";
          
          if (result.resolvedUrl) {
            lead.website = result.resolvedUrl;
          }

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

          updatePreviewRowData(index, lead.email, lead.websiteStatus, lead.website);
        } catch (err) {
          console.error("Scraping queue error", index, err);
          lead.email = "N/A";
          lead.websiteStatus = "Offline";
          updatePreviewRowData(index, "N/A", "Offline", lead.website);
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

    if (shouldStopDeepScraping) {
      // Already cleaned up and saved immediately in the stop click handler
      return;
    }

    progressLabel.textContent = "Website scraping complete!";
    showToast(`Scrape complete! Found emails for listings.`, "success");
    
    // Save to storage cache
    chrome.storage.local.set({ lastScrapedLeads: leads });

    // Enable export actions
    resetScraperState();
    btnExportCsv.disabled = false;
    btnClearHistory.disabled = false;

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
    const headers = ["Name", "Location", "Google Maps Link", "Phone Number", "Email", "Website", "Website Status", "Social Media"];
    
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
        escapeCSV(lead.websiteStatus || "N/A"),
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
    link.setAttribute("download", `Leadiction_export_${timestamp}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showToast("CSV file exported successfully!", "success");
  });

  // Clear history
  btnClearHistory.addEventListener("click", () => {
    chrome.storage.local.remove(["lastScrapedLeads"], () => {
      currentLeads = [];
      leadsCount.textContent = "0";
      renderPreviewTable(currentLeads);
      btnExportCsv.disabled = true;
      btnClearHistory.disabled = true;
      showToast("Scraped history cleared.", "success");
    });
  });

  // Listen for progress or completed scraping updates from content script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "scrapingProgress" || message.action === "scrapingComplete") {
      // Prevent messages from other tabs if we initiated a scrape
      if (activeTabId && sender.tab && sender.tab.id !== activeTabId) {
        return;
      }

      if (message.listings) {
        // Map elements to currentLeads, preserving "N/A" for emails initially
        currentLeads = message.listings.map(lead => ({
          ...lead,
          email: "N/A",
          websiteStatus: "N/A"
        }));
        leadsCount.textContent = currentLeads.length;
        
        // Render Table Preview
        renderPreviewTable(currentLeads);
      }

      if (message.action === "scrapingComplete") {
        if (userStoppedScraping) {
          userStoppedScraping = false;
          resetScraperState();
          chrome.storage.local.set({ lastScrapedLeads: currentLeads });
          btnExportCsv.disabled = false;
          btnClearHistory.disabled = false;
          showToast(`Scraping stopped. Saved ${currentLeads.length} leads.`, "success");
          return;
        }

        if (currentLeads.length > 0) {
          const hasWebsites = currentLeads.some(lead => lead.website && lead.website !== "N/A" && lead.website.trim() !== "");
          
          if (hasWebsites) {
            currentPhase = "crawling";
            // Do not disable btnStop, we use it to stop deep crawling!
            btnScrape.disabled = true;
            scrapeSpinner.classList.add("hidden");
            // Launch deep website scraping (which crawls email addresses and updates rows)
            deepScrapeAllWebsites(currentLeads);
          } else {
            resetScraperState();
            // Save to storage cache immediately
            chrome.storage.local.set({ lastScrapedLeads: currentLeads });
            btnExportCsv.disabled = false;
            btnClearHistory.disabled = false;
            showToast(`Scraped ${currentLeads.length} leads (no websites to crawl).`, "success");
          }
        } else {
          resetScraperState();
          btnExportCsv.disabled = true;
          btnClearHistory.disabled = true;
          showToast("No listings detected on this page.", "error");
        }
      }
    }
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
