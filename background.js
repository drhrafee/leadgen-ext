// background.js - Service worker for background operations and context menus

// Configure Side Panel behavior in Manifest V3
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error("Error setting panel behavior:", error));
}

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

// Orchestrates homepage and potential contact subpage crawling, returning email, socials and site status
async function scrapeWebsite(url) {
  if (!url || url === "N/A" || url.trim() === "") {
    return { email: "N/A", socialMedia: "N/A", websiteStatus: "N/A" };
  }

  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = "https://" + targetUrl;
  }

  // Resolve Google Ads redirect URLs before getting the origin
  if (targetUrl.includes("aclk") || targetUrl.includes("googleadservices.com")) {
    try {
      console.log(`Resolving ad redirect URL: ${targetUrl}`);
      const redirectResponse = await fetch(targetUrl, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36"
        }
      });
      if (redirectResponse && redirectResponse.url) {
        targetUrl = redirectResponse.url;
        console.log(`Ad redirect resolved to: ${targetUrl}`);
      }
    } catch (err) {
      console.warn(`Failed to resolve ad redirect URL ${targetUrl}:`, err.message);
    }
  }

  try {
    const urlObj = new URL(targetUrl);
    targetUrl = urlObj.origin;
  } catch (e) {
    // fallback if parsing fails
  }

  try {
    console.log(`Starting deep scrape for: ${targetUrl}`);
    const result = await fetchAndParse(targetUrl);
    
    if (result.error) {
      return { email: "N/A", socialMedia: "N/A", websiteStatus: result.error, resolvedUrl: targetUrl };
    }

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
      
      if (!subpageResult.error) {
        if (subpageResult.email !== "N/A") {
          result.email = subpageResult.email;
        }
        
        // Merge social links if new ones were discovered on subpage
        if (subpageResult.rawSocials && subpageResult.rawSocials.length > 0) {
          const mergedSocials = Array.from(new Set([...(result.rawSocials || []), ...subpageResult.rawSocials]));
          result.socialMedia = formatSocialLinks(mergedSocials);
        }
      }
    }

    return {
      email: result.email,
      socialMedia: result.socialMedia,
      websiteStatus: "Healthy",
      resolvedUrl: targetUrl
    };
  } catch (error) {
    console.warn(`Failed to fetch website details for ${targetUrl}:`, error.message);
    return { email: "N/A", socialMedia: "N/A", websiteStatus: "Offline", resolvedUrl: targetUrl };
  }
}

// Fetch helper with AbortController timeout and status tracking
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
      return { error: `HTTP ${response.status}` };
    }

    const html = await response.text();
    const parsed = parseHTMLContent(html, url);
    return { ...parsed, ok: true };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      return { error: "Timeout (6s)" };
    }
    const msg = (err.message || "").toLowerCase();
    if (msg.includes("failed to fetch") || msg.includes("network") || msg.includes("dns") || msg.includes("fetch")) {
      return { error: "DNS/Offline" };
    }
    return { error: "Offline" };
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

