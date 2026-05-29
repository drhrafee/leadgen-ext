// content.js - Scrapes business listings from Google Maps and Google Search pages.

(() => {
  if (window.hasLeadictionContentScriptInjected) {
    return;
  }
  window.hasLeadictionContentScriptInjected = true;

// Helper to check if a string looks like a phone number
function isPhoneNumber(str) {
  // Strip spaces, dashes, parentheses, and plus signs
  const clean = str.replace(/[\s\-\(\)\+]/g, '');
  // A phone number should consist entirely of digits and be between 7 and 15 digits long
  return /^\d{7,15}$/.test(clean);
}

// Helper to clean external website links (ignoring Google internal domains)
function getExternalWebsite(href, element) {
  let target = href;
  if (element) {
    target = element.getAttribute('data-adurl') || element.getAttribute('data-url') || target;
  }
  if (!target) return null;
  try {
    target = target.trim();
    
    // Resolve Google Search redirect URLs (e.g. /url?q=https://example.com)
    if (target.startsWith("/url?") || target.includes("google.com/url?")) {
      try {
        const parsedUrl = new URL(target, window.location.origin);
        const qParam = parsedUrl.searchParams.get("q");
        if (qParam) {
          target = qParam;
        }
      } catch (e) {}
    }
    
    // Resolve Google Ad redirect URLs (e.g. /aclk?adurl=https://example.com)
    if (target.includes("aclk") || target.includes("googleadservices.com")) {
      try {
        const parsedUrl = new URL(target, window.location.origin);
        const adParam = parsedUrl.searchParams.get("adurl") || 
                        parsedUrl.searchParams.get("q") || 
                        parsedUrl.searchParams.get("url");
        if (adParam) {
          target = adParam;
        } else {
          // If we couldn't find the target parameter in the query, return the absolute aclk URL
          // so that background.js can resolve the redirect.
          return parsedUrl.href;
        }
      } catch (e) {
        try {
          return new URL(target, window.location.origin).href;
        } catch (err) {
          return target;
        }
      }
    }

    if (!/^https?:\/\//i.test(target)) {
      target = "https://" + target;
    }
    const url = new URL(target);
    const domain = url.hostname.toLowerCase();
    if (
      domain.includes("google.com") ||
      domain.includes("google.co") ||
      domain.includes("googleadservices.com") ||
      domain.includes("gstatic.com") ||
      domain.includes("ggpht.com") ||
      domain.includes("youtube.com") ||
      domain.includes("wikipedia.org") ||
      target.startsWith("chrome-extension://") ||
      target.startsWith("javascript:")
    ) {
      return null;
    }
    
    // If it's a social media link, return the full target URL
    if (getSocialMediaLink(target)) {
      return target;
    }
    
    // Otherwise, return only the homepage (origin)
    return url.origin;
  } catch (e) {
    return null;
  }
}

// Helper to identify social media links
function getSocialMediaLink(href) {
  if (!href) return null;
  const socials = ["facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com", "youtube.com", "pinterest.com", "tiktok.com"];
  const hrefLower = href.toLowerCase();
  for (const social of socials) {
    if (hrefLower.includes(social)) {
      return href;
    }
  }
  return null;
}

// Heuristic to calculate a score for potential address strings
function getAddressScore(part, businessName) {
  let score = 0;
  const partLower = part.toLowerCase().trim();
  
  if (!partLower) return -100;
  
  // Exclude opening hours, schedules, or status terms
  const isSchedule = /(?:^|\s|·)(?:open|closed|closes|opens|24\s*hours|24\/7|hours)(?:\s|$|·)/i.test(partLower) ||
                     /\b\d{1,2}(?:\s*am|\s*pm)\b/i.test(partLower) ||
                     /\d{1,2}–\d{1,2}/.test(partLower) ||
                     /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(partLower);
  if (isSchedule) {
    return -100;
  }
  
  // If the part is exactly the name or contains the name, it's not the address
  if (businessName) {
    const nameLower = businessName.toLowerCase().trim();
    if (partLower === nameLower || partLower.includes(nameLower) || nameLower.includes(partLower)) {
      return -100; // Block this candidate
    }
  }

  // If it contains quotes or looks like a review, heavily penalize
  if (partLower.includes('"') || partLower.includes('“') || partLower.includes('”') || partLower.includes("'") || partLower.includes('`')) {
    score -= 40;
  }
  
  // Review words
  const reviewWords = ['recommend', 'job', 'work', 'staff', 'friendly', 'highly', 'great', 'professional', 'helpful', 'prompt', 'quick', 'good', 'nice', 'excellent', 'fantastic', 'amazing', 'brilliant', 'perfect', 'reliable', 'experience', 'quality', 'price', 'cost', 'money', 'time', 'efficient', 'polite', 'honest', 'tidy', 'clean'];
  reviewWords.forEach(word => {
    if (partLower.includes(word)) score -= 15;
  });

  // Category words
  const categoryWords = ['service', 'rental', 'supplier', 'contractor', 'office', 'designer', 'clinic', 'dentist', 'restaurant', 'store', 'shop', 'dealer', 'manufacturer', 'agency', 'company', 'ltd', 'limited', 'inc', 'co', 'group', 'association', 'club', 'school', 'college', 'university', 'hospital', 'builders', 'materials', 'supplies', 'hire', 'sales', 'consultant', 'adviser', 'specialist', 'expert', 'scaffolding'];
  categoryWords.forEach(word => {
    if (partLower.includes(word)) score -= 10;
  });

  // Positive indicators for address (digits, commas, address terms)
  if (/\d/.test(partLower)) score += 15;
  if (partLower.includes(',')) score += 10;
  
  const addressWords = ['road', 'rd', 'street', 'st', 'way', 'lane', 'ln', 'avenue', 'ave', 'drive', 'dr', 'court', 'ct', 'place', 'pl', 'park', 'estate', 'industrial', 'unit', 'suite', 'farm', 'building', 'bldg', 'close', 'cl', 'terrace', 'terr', 'square', 'sq', 'highway', 'hwy', 'broadway', 'bypass', 'crescent', 'cres', 'gardens', 'gdns', 'grove', 'grv', 'parade', 'pde', 'rise', 'vale', 'view', 'walk', 'yard', 'wharf'];
  addressWords.forEach(word => {
    if (partLower.includes(word)) score += 8;
  });

  // UK/US Postcode indicators (e.g. LS9 0QD, 10001, etc.)
  if (/[A-Z]{1,2}[0-9R][0-9A-Z]?\s*[0-9][A-Z]{2}/i.test(partLower)) score += 20;
  if (/\b\d{5}(-\d{4})?\b/.test(partLower)) score += 20;

  return score;
}

// Helper to extract phone and location details from a card's inner text elements
function parseDetailsFromCard(searchArea, businessName) {
  const textEls = searchArea.querySelectorAll('span, div');
  const rawParts = [];
  
  textEls.forEach(el => {
    const textVal = (el.innerText || el.textContent || "").trim().replace(/[\r\n]+/g, ', ');
    // Get text of leaf elements to avoid duplicates from nested containers
    if (el.children.length === 0 && textVal) {
      // Split on bullet characters commonly used as delimiters on Google Maps & Search
      if (textVal.includes('·')) {
        textVal.split('·').forEach(part => rawParts.push(part.trim()));
      } else {
        rawParts.push(textVal);
      }
    }
  });

  let phone = "N/A";
  let addressCandidates = [];

  rawParts.forEach(part => {
    if (!part) return;
    
    if (isPhoneNumber(part)) {
      if (phone === "N/A") {
        phone = part;
      }
    } else {
      addressCandidates.push(part);
    }
  });

  let location = "N/A";
  if (addressCandidates.length > 0) {
    let bestScore = -999;
    let bestCandidate = "N/A";
    
    addressCandidates.forEach(cand => {
      const score = getAddressScore(cand, businessName);
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = cand;
      }
    });
    
    // Only accept candidate if the score is somewhat reasonable (above -15)
    if (bestScore >= -15) {
      location = bestCandidate;
    }
  }

  return { phone, location };
}

// 1. Google Maps Scraper
function scrapeGoogleMaps() {
  const listings = [];
  
  // Google Maps listings typically link to /maps/place/
  const links = document.querySelectorAll('a[href*="/maps/place/"]');
  
  links.forEach(link => {
    // Traverse up to find the container that belongs ONLY to this listing
    let card = link.parentElement;
    let bestCard = card;
    while (card && card !== document.body) {
      const listingLinks = card.querySelectorAll('a[href*="/maps/place/"]');
      const uniqueHrefs = new Set();
      listingLinks.forEach(l => {
        const href = l.getAttribute('href');
        if (href) {
          const baseHref = href.split('/@')[0];
          uniqueHrefs.add(baseHref);
        }
      });
      if (uniqueHrefs.size > 1) {
        break;
      }
      bestCard = card;
      card = card.parentElement;
    }
    const searchArea = bestCard || link;
    
    // Name
    let name = link.getAttribute('aria-label') || link.innerText || "";
    if (!name) {
      const headingEl = searchArea.querySelector('.qbf1Pd');
      if (headingEl) name = headingEl.innerText;
    }
    name = name.trim();
    if (!name) return;
    
    // Maps URL
    const mapsLink = link.getAttribute('href') || "";
    
    // Parse website and social links from card anchors
    let website = "N/A";
    let socialMedia = "N/A";
    const cardLinks = searchArea.querySelectorAll('a');
    cardLinks.forEach(cl => {
      const href = cl.getAttribute('href');
      const extWeb = getExternalWebsite(href, cl);
      if (extWeb) {
        const social = getSocialMediaLink(extWeb);
        if (social) {
          socialMedia = social;
        } else {
          const isAclk = extWeb.includes("aclk") || extWeb.includes("googleadservices.com");
          const currentIsAclk = website.includes("aclk") || website.includes("googleadservices.com") || website === "N/A";
          if (currentIsAclk || !isAclk) {
            website = extWeb;
          }
        }
      }
    });

    // Parse phone and location using bullet-split helper
    const details = parseDetailsFromCard(searchArea, name);
    
    listings.push({
      name: name,
      location: details.location,
      mapsLink: mapsLink,
      phone: details.phone,
      website: website,
      socialMedia: socialMedia
    });
  });
  
  return listings;
}

// 2. Google Search Local Pack / Business List Scraper
function scrapeGoogleSearch() {
  const listings = [];
  
  const cards = document.querySelectorAll('div[data-cid], .C8nzq, .rllt__details');
  
  cards.forEach(card => {
    let nameEl = card.querySelector('.dbg0pd, .OSrXXb, h3[role="heading"]');
    let name = nameEl ? nameEl.innerText.trim() : "";
    if (!name) return;
    
    let mapsLink = "N/A";
    const mapsEl = card.querySelector('a[href*="google.com/maps"], a[href*="maps.google.com"]');
    if (mapsEl) {
      mapsLink = mapsEl.getAttribute('href');
    } else {
      mapsLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}`;
    }
    
    let website = "N/A";
    let socialMedia = "N/A";
    const links = card.querySelectorAll('a');
    links.forEach(link => {
      const href = link.getAttribute('href');
      const extWeb = getExternalWebsite(href, link);
      if (extWeb) {
        const social = getSocialMediaLink(extWeb);
        if (social) {
          socialMedia = social;
        } else {
          const isAclk = extWeb.includes("aclk") || extWeb.includes("googleadservices.com");
          const currentIsAclk = website.includes("aclk") || website.includes("googleadservices.com") || website === "N/A";
          if (currentIsAclk || !isAclk) {
            website = extWeb;
          }
        }
      }
    });

    if (website === "N/A") {
      const webBtn = card.querySelector('a[aria-label*="Website"], a.yYVVDd');
      if (webBtn) {
        const href = webBtn.getAttribute('href');
        const extWeb = getExternalWebsite(href, webBtn);
        if (extWeb) website = extWeb;
      }
    }
    
    // Parse phone and location using bullet-split helper
    const details = parseDetailsFromCard(card, name);
    
    listings.push({
      name: name,
      location: details.location,
      mapsLink: mapsLink,
      phone: details.phone,
      website: website,
      socialMedia: socialMedia
    });
  });

  // Fallback local pack parser
  if (listings.length === 0) {
    const localPackHeaders = document.querySelectorAll('div.Vk5nOf h3');
    localPackHeaders.forEach(header => {
      const name = header.innerText.trim();
      const parent = header.closest('div.Vk5nOf') || header.parentElement;
      if (!name || !parent) return;

      let website = "N/A";
      let mapsLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}`;
      
      const link = parent.querySelector('a');
      if (link) {
        const href = link.getAttribute('href');
        const ext = getExternalWebsite(href, link);
        if (ext) website = ext;
      }

      const details = parseDetailsFromCard(parent, name);

      listings.push({
        name: name,
        location: details.location,
        mapsLink: mapsLink,
        phone: details.phone,
        website: website,
        socialMedia: "N/A"
      });
    });
  }
  
  return listings;
}

// Robust helper to locate the scrollable feed container on Google Maps
function findMapsFeedContainer() {
  // 1. Try standard role="feed"
  let feed = document.querySelector('div[role="feed"]');
  if (feed) return feed;

  // 2. Traverse up from a listing link to find a scrollable parent
  const firstLink = document.querySelector('a[href*="/maps/place/"]');
  if (firstLink) {
    let parent = firstLink.parentElement;
    while (parent && parent !== document.body) {
      const style = window.getComputedStyle(parent);
      const overflow = style.getPropertyValue('overflow-y') || style.getPropertyValue('overflow');
      if (overflow.includes('auto') || overflow.includes('scroll')) {
        return parent;
      }
      if (parent.classList.contains('m67p50') || parent.classList.contains('ecr1z')) {
        return parent;
      }
      parent = parent.parentElement;
    }
  }
  
  // 3. Fallback class selectors
  return document.querySelector('.m67p50, .ecr1z, .Gpq6kf');
}

let shouldStopScraping = false;

// Helper to auto-scroll Google Maps listings feed to load more listings, scraping incrementally
async function autoScrollGoogleMapsIncremental(maxResults = 50, progressCallback) {
  console.log(`Auto-scrolling Google Maps feed up to ${maxResults} results incrementally...`);
  
  const feed = findMapsFeedContainer();
  if (!feed) {
    const links = document.querySelectorAll('a[href*="/maps/place/"]');
    if (links.length > 1) {
      console.warn("Could not find scrollable feed pane");
    }
    progressCallback(true);
    return;
  }

  let lastHeight = feed.scrollHeight;
  let noChangeCount = 0;
  const maxNoChange = 6; // Stop if scroll height doesn't change after 6 scroll checks (~9s)
  
  while (true) {
    if (shouldStopScraping) {
      console.log("Auto-scroll stopped by user command.");
      break;
    }

    const links = feed.querySelectorAll('a[href*="/maps/place/"]');
    
    // Scrape current listings and notify progress
    progressCallback(false);

    if (links.length >= maxResults) {
      console.log(`Loaded ${links.length} listings. Reached requested limit of ${maxResults}.`);
      break;
    }

    const startCount = feed.querySelectorAll('a[href*="/maps/place/"]').length;
    const startHeight = feed.scrollHeight;

    // Scroll container to bottom
    feed.scrollTo(0, feed.scrollHeight);
    
    // Wait dynamically up to 1.5 seconds for either new links or a height change
    let elapsed = 0;
    const checkInterval = 100;
    const maxWait = 1500;
    while (elapsed < maxWait) {
      if (shouldStopScraping) break;
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      elapsed += checkInterval;
      
      const currentCount = feed.querySelectorAll('a[href*="/maps/place/"]').length;
      const currentHeight = feed.scrollHeight;
      if (currentCount > startCount || currentHeight > startHeight) {
        break; // new items loaded! proceed to next scroll
      }
    }
    
    const newHeight = feed.scrollHeight;
    if (newHeight === lastHeight) {
      noChangeCount++;
      if (noChangeCount >= maxNoChange) {
        console.log("Reached bottom of listings pane (no scroll height change).");
        break;
      }
    } else {
      noChangeCount = 0;
      lastHeight = newHeight;
    }

    // Check for "Reached end of list" or "Back to top" button
    let reachedEnd = false;
    const endTextQuery = ["reached the end of the list", "no more results", "you've reached the end", "back to top"];
    const allEls = feed.querySelectorAll('span, div, button');
    for (const el of allEls) {
      const text = (el.innerText || el.textContent || "").toLowerCase().trim();
      if (endTextQuery.some(q => text.includes(q))) {
        reachedEnd = true;
        break;
      }
    }
    if (reachedEnd) {
      console.log("Reached the end of Google Maps listings feed.");
      break;
    }
  }

  // Final complete scrape
  progressCallback(true);
}

// Helper to parse business listings from a custom HTML string
function scrapeFromHtmlString(htmlContent) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlContent, 'text/html');
  const listings = [];
  const cards = doc.querySelectorAll('div[data-cid], .C8nzq, .rllt__details');
  
  cards.forEach(card => {
    let nameEl = card.querySelector('.dbg0pd, .OSrXXb, h3[role="heading"]');
    let name = nameEl ? nameEl.innerText.trim() : "";
    if (!name) return;
    
    let mapsLink = "N/A";
    const mapsEl = card.querySelector('a[href*="google.com/maps"], a[href*="maps.google.com"]');
    if (mapsEl) {
      mapsLink = mapsEl.getAttribute('href');
    } else {
      mapsLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}`;
    }
    
    let website = "N/A";
    let socialMedia = "N/A";
    const links = card.querySelectorAll('a');
    links.forEach(link => {
      const href = link.getAttribute('href');
      const extWeb = getExternalWebsite(href, link);
      if (extWeb) {
        const social = getSocialMediaLink(extWeb);
        if (social) {
          socialMedia = social;
        } else {
          const isAclk = extWeb.includes("aclk") || extWeb.includes("googleadservices.com");
          const currentIsAclk = website.includes("aclk") || website.includes("googleadservices.com") || website === "N/A";
          if (currentIsAclk || !isAclk) {
            website = extWeb;
          }
        }
      }
    });

    if (website === "N/A") {
      const webBtn = card.querySelector('a[aria-label*="Website"], a.yYVVDd');
      if (webBtn) {
        const href = webBtn.getAttribute('href');
        const extWeb = getExternalWebsite(href, webBtn);
        if (extWeb) website = extWeb;
      }
    }
    
    // Parse phone and location using bullet-split helper
    const details = parseDetailsFromCard(card, name);
    
    listings.push({
      name: name,
      location: details.location,
      mapsLink: mapsLink,
      phone: details.phone,
      website: website,
      socialMedia: socialMedia
    });
  });
  
  return listings;
}

// Extract search query from current page URL or titles
function getSearchQuery() {
  const url = window.location.href;
  if (url.includes("google.com/maps") || (url.includes("google.co") && url.includes("/maps"))) {
    const match = url.match(/\/maps\/search\/([^\/\?@]+)/);
    if (match && match[1]) {
      return decodeURIComponent(match[1].replace(/\+/g, " "));
    }
  } else {
    try {
      const parsedUrl = new URL(url);
      const q = parsedUrl.searchParams.get("q");
      if (q) return q;
    } catch (e) {}
  }
  
  // Fallback 1: Page title
  const title = document.title;
  if (title.includes("- Google Maps")) {
    return title.split("- Google Maps")[0].trim();
  }
  if (title.includes("- Google Search")) {
    return title.split("- Google Search")[0].trim();
  }
  
  // Fallback 2: Search inputs
  const searchInput = document.querySelector('input[name="q"], #searchboxinput');
  if (searchInput && searchInput.value) {
    return searchInput.value;
  }
  
  return null;
}

// Backend (No-Scroll) Scraper using Google Search Local Finder (tbm=lcl)
async function scrapeSearchInBackend(query, maxResults = 50, progressCallback) {
  console.log(`Scraping in backend for query: "${query}" up to ${maxResults} results...`);
  
  let currentStart = 0;
  let noResultsCount = 0;
  let totalScraped = 0;
  const uniqueMap = new Map();
  
  while (totalScraped < maxResults) {
    if (shouldStopScraping) {
      console.log("Backend scraping stopped by user.");
      break;
    }
    
    const url = `https://www.google.com/search?tbm=lcl&q=${encodeURIComponent(query)}&start=${currentStart}`;
    try {
      const response = await fetch(url, {
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36"
        }
      });
      if (!response.ok) {
        console.error(`HTTP error: ${response.status}`);
        break;
      }
      
      const html = await response.text();
      const listings = scrapeFromHtmlString(html);
      
      if (listings.length === 0) {
        noResultsCount++;
        if (noResultsCount >= 2) {
          console.log("No more listings found in backend search results.");
          break;
        }
      } else {
        noResultsCount = 0;
        
        listings.forEach(item => {
          const key = `${item.name.toLowerCase()}_${item.phone.toLowerCase()}`;
          if (!uniqueMap.has(key)) {
            uniqueMap.set(key, item);
          }
        });
        
        totalScraped = uniqueMap.size;
        progressCallback(Array.from(uniqueMap.values()), false);
      }
      
      currentStart += 20;
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (err) {
      console.error("Backend scrape error at start", currentStart, err);
      break;
    }
  }
  
  progressCallback(Array.from(uniqueMap.values()), true);
}

// Message Listener from Popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "stopScraping") {
    shouldStopScraping = true;
    sendResponse({ status: "stopping" });
    return false;
  }

  if (request.action === "scrapeCurrentPage") {
    const url = window.location.href;
    const isMaps = url.includes("google.com/maps") || (url.includes("google.co") && url.includes("/maps"));
    
    shouldStopScraping = false;

    // Respond immediately to prevent message channel timeout
    sendResponse({ status: "started" });

    (async () => {
      let uniqueListings = [];
      const uniqueMap = new Map();

      // Helper to scrape, deduplicate and send update
      const scrapeAndSendUpdate = (isComplete = false) => {
        let results = [];
        try {
          if (isMaps) {
            results = scrapeGoogleMaps();
          } else if (url.includes("google.com") || url.includes("google.co")) {
            results = scrapeGoogleSearch();
          }
        } catch (err) {
          console.error("Error scraping page:", err);
        }

        // De-duplicate results by Name + Phone
        results.forEach(item => {
          const key = `${item.name.toLowerCase()}_${item.phone.toLowerCase()}`;
          if (!uniqueMap.has(key)) {
            uniqueMap.set(key, item);
          }
        });

        uniqueListings = Array.from(uniqueMap.values());

        // Save to storage cache immediately
        chrome.storage.local.set({ lastScrapedLeads: uniqueListings.map(lead => ({ ...lead, email: "N/A" })) }, () => {
          // Send update message back to popup
          chrome.runtime.sendMessage({
            action: isComplete ? "scrapingComplete" : "scrapingProgress",
            listings: uniqueListings,
            url: url,
            title: document.title
          }, (response) => {
            if (chrome.runtime.lastError) {
              // Benign
            }
          });
        });
      };

      if (request.autoScroll) {
        const query = getSearchQuery();
        if (query) {
          try {
            await scrapeSearchInBackend(query, request.maxResults || 50, (listings, isComplete) => {
              listings.forEach(item => {
                const key = `${item.name.toLowerCase()}_${item.phone.toLowerCase()}`;
                if (!uniqueMap.has(key)) {
                  uniqueMap.set(key, item);
                }
              });

              uniqueListings = Array.from(uniqueMap.values());

              chrome.storage.local.set({ lastScrapedLeads: uniqueListings.map(lead => ({ ...lead, email: "N/A" })) }, () => {
                chrome.runtime.sendMessage({
                  action: isComplete ? "scrapingComplete" : "scrapingProgress",
                  listings: uniqueListings,
                  url: url,
                  title: document.title
                }, (response) => {
                  if (chrome.runtime.lastError) {
                    // Benign
                  }
                });
              });
            });
          } catch (err) {
            console.error("Error during backend scrape, falling back to UI auto-scroll:", err);
            if (isMaps) {
              await autoScrollGoogleMapsIncremental(request.maxResults || 50, scrapeAndSendUpdate);
            } else {
              scrapeAndSendUpdate(true);
            }
          }
        } else {
          // Fallback to UI auto-scroll if query not extracted
          if (isMaps) {
            await autoScrollGoogleMapsIncremental(request.maxResults || 50, scrapeAndSendUpdate);
          } else {
            scrapeAndSendUpdate(true);
          }
        }
      } else {
        // Just scrape once
        scrapeAndSendUpdate(true);
      }
    })();

    return false; // Return false since response is already sent synchronously
  }
});

})();
