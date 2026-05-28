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

// --- WEBSITE DEEP SCRAPING LOGIC ---

// Listen for deep-scraping requests from the popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "scrapeWebsiteDetails") {
    const { url } = message;
    scrapeWebsite(url)
      .then(result => sendResponse(result))
      .catch(error => {
        console.error("Scrape error for", url, error);
        sendResponse({ email: "N/A", socialMedia: "N/A" });
      });
    return true; // Keep message port open for async response
  }
});

// Orchestrates homepage and potential contact subpage crawling
async function scrapeWebsite(url) {
  if (!url || url === "N/A" || url.trim() === "") {
    return { email: "N/A", socialMedia: "N/A" };
  }

  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = "https://" + targetUrl;
  }

  try {
    console.log(`Starting deep scrape for: ${targetUrl}`);
    const result = await fetchAndParse(targetUrl);
    
    // If no email found on homepage, try to search in Contact/About subpages
    if (result.email === "N/A" && result.subpageCandidates && result.subpageCandidates.length > 0) {
      const baseObj = new URL(targetUrl);
      const subpagePath = result.subpageCandidates[0];
      let subpageUrl = "";
      
      try {
        subpageUrl = new URL(subpagePath, baseObj.origin).href;
      } catch (err) {
        subpageUrl = baseObj.origin + (subpagePath.startsWith("/") ? "" : "/") + subpagePath;
      }

      console.log(`No email on homepage. Trying subpage: ${subpageUrl}`);
      const subpageResult = await fetchAndParse(subpageUrl);
      if (subpageResult.email !== "N/A") {
        result.email = subpageResult.email;
      }
      
      // Merge social links if new ones were discovered on subpage
      if (subpageResult.rawSocials && subpageResult.rawSocials.length > 0) {
        const mergedSocials = Array.from(new Set([...(result.rawSocials || []), ...subpageResult.rawSocials]));
        result.socialMedia = formatSocialLinks(mergedSocials);
      }
    }

    return {
      email: result.email,
      socialMedia: result.socialMedia
    };
  } catch (error) {
    console.warn(`Failed to fetch website details for ${targetUrl}:`, error.message);
    return { email: "N/A", socialMedia: "N/A" };
  }
}

// Fetch helper with AbortController timeout
async function fetchAndParse(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000); // 6s timeout

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36"
      }
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP status ${response.status}`);
    }

    const html = await response.text();
    return parseHTMLContent(html, url);
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// Regex-based HTML content parsing to extract emails and links (no DOMParser in Service Worker)
function parseHTMLContent(html, baseUrl) {
  // 1. Extract Emails
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,20}/g;
  const emails = [];
  let emailMatch;
  while ((emailMatch = emailRegex.exec(html)) !== null) {
    const email = emailMatch[0].trim();
    // Exclude common static binary/asset formats
    const isAsset = /\.(png|jpg|jpeg|gif|svg|webp|css|js|pdf|woff|woff2|ttf|eot|mp4|webm|mov|ogg)$/i.test(email);
    const isInvalid = email.includes("bootstrap") || email.includes("jquery") || email.endsWith(".com.com") || email.startsWith("email@");
    
    if (!isAsset && !isInvalid) {
      emails.push(email);
    }
  }

  const uniqueEmails = Array.from(new Set(emails));
  const finalEmail = uniqueEmails.length > 0 ? uniqueEmails.join(", ") : "N/A";

  // 2. Extract links (hrefs)
  const hrefRegex = /href=["']([^"']+)["']/gi;
  const socialLinks = [];
  const subpageCandidates = [];
  let hrefMatch;

  const socialDomains = ["facebook.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "youtube.com", "pinterest.com", "tiktok.com"];
  
  while ((hrefMatch = hrefRegex.exec(html)) !== null) {
    const link = hrefMatch[1].trim();
    if (!link || link.startsWith("#") || link.startsWith("javascript:")) continue;

    const linkLower = link.toLowerCase();
    const isSocial = socialDomains.some(domain => linkLower.includes(domain));
    if (isSocial) {
      socialLinks.push(link);
    } else {
      // Look for relative or absolute internal Contact/About sub-page candidates
      const isSubpageCandidate = /contact|about|info|email|support/i.test(link);
      let isInternal = false;
      try {
        if (link.startsWith("/") || !/^https?:\/\//i.test(link)) {
          isInternal = true;
        } else {
          const pageHost = new URL(baseUrl).hostname.replace('www.', '');
          const linkHost = new URL(link).hostname.replace('www.', '');
          if (pageHost === linkHost) {
            isInternal = true;
          }
        }
      } catch (e) {
        if (link.startsWith("/")) isInternal = true;
      }

      if (isSubpageCandidate && isInternal) {
        subpageCandidates.push(link);
      }
    }
  }

  const uniqueSocials = Array.from(new Set(socialLinks));
  const socialMediaStr = formatSocialLinks(uniqueSocials);
  const sortedSubpages = sortSubpageCandidates(Array.from(new Set(subpageCandidates)));

  return {
    email: finalEmail,
    socialMedia: socialMediaStr,
    rawSocials: uniqueSocials,
    subpageCandidates: sortedSubpages
  };
}

function formatSocialLinks(socials) {
  if (socials.length === 0) return "N/A";
  return socials.join(", ");
}

function sortSubpageCandidates(links) {
  return links.sort((a, b) => {
    const score = (link) => {
      const l = link.toLowerCase();
      if (l.includes("contact-us") || l.includes("contactus")) return 5;
      if (l.includes("contact")) return 4;
      if (l.includes("about-us") || l.includes("aboutus")) return 3;
      if (l.includes("about")) return 2;
      if (l.includes("info") || l.includes("email") || l.includes("support")) return 1;
      return 0;
    };
    return score(b) - score(a);
  });
}

