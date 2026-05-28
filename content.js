// content.js - Scrapes business listings from Google Maps and Google Search pages.

// Helper to check if a string looks like a phone number
function isPhoneNumber(str) {
  // Strip spaces, dashes, parentheses, and plus signs
  const clean = str.replace(/[\s\-\(\)\+]/g, '');
  // A phone number should consist entirely of digits and be between 7 and 15 digits long
  return /^\d{7,15}$/.test(clean);
}

// Helper to clean external website links (ignoring Google internal domains)
function getExternalWebsite(href) {
  if (!href) return null;
  try {
    const url = new URL(href);
    const domain = url.hostname.toLowerCase();
    if (
      domain.includes("google.com") ||
      domain.includes("google.co") ||
      domain.includes("gstatic.com") ||
      domain.includes("ggpht.com") ||
      domain.includes("youtube.com") ||
      domain.includes("wikipedia.org") ||
      href.startsWith("chrome-extension://") ||
      href.startsWith("javascript:")
    ) {
      return null;
    }
    return href;
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
    // Get text of leaf elements to avoid duplicates from nested containers
    if (el.children.length === 0 && el.innerText.trim()) {
      // Replace newlines with commas to avoid breaking CSV/Excel vertical layouts
      const textVal = el.innerText.trim().replace(/[\r\n]+/g, ', ');
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
    let card = link.closest('div[role="feed"] > div');
    if (!card) {
      let parent = link.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        if (parent.querySelector('.lvyw2d') || parent.querySelector('a[data-value="Website"]')) {
          card = parent;
          break;
        }
        parent = parent.parentElement;
      }
    }
    
    const searchArea = card || link.parentElement || link;
    
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
      const extWeb = getExternalWebsite(href);
      if (extWeb) {
        const social = getSocialMediaLink(extWeb);
        if (social) {
          socialMedia = social;
        } else {
          website = extWeb;
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
      const extWeb = getExternalWebsite(href);
      if (extWeb) {
        const social = getSocialMediaLink(extWeb);
        if (social) {
          socialMedia = social;
        } else {
          website = extWeb;
        }
      }
    });

    if (website === "N/A") {
      const webBtn = card.querySelector('a[aria-label*="Website"], a.yYVVDd');
      if (webBtn) {
        const href = webBtn.getAttribute('href');
        const extWeb = getExternalWebsite(href);
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
        const ext = getExternalWebsite(href);
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
// Helper to auto-scroll Google Maps listings feed to load more listings
async function autoScrollGoogleMaps(maxResults = 50) {
  console.log(`Auto-scrolling Google Maps feed up to ${maxResults} results...`);
  
  const feed = document.querySelector('div[role="feed"]');
  if (!feed) {
    console.warn("Could not find scrollable feed pane (div[role='feed'])");
    return;
  }

  let lastHeight = feed.scrollHeight;
  let noChangeCount = 0;
  const maxNoChange = 6; // Stop if scroll height doesn't change after 6 scroll checks (~9s)
  
  while (true) {
    const links = feed.querySelectorAll('a[href*="/maps/place/"]');
    if (links.length >= maxResults) {
      console.log(`Loaded ${links.length} listings. Reached requested limit of ${maxResults}.`);
      break;
    }

    // Scroll container to bottom
    feed.scrollTo(0, feed.scrollHeight);
    
    // Wait for DOM items to load (1.5 seconds)
    await new Promise(resolve => setTimeout(resolve, 1500));
    
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

    // Check for "Reached end of list" notification in feed
    const textEls = feed.querySelectorAll('span, div');
    let reachedEnd = false;
    for (const el of textEls) {
      if (el.children.length === 0 && el.innerText) {
        const text = el.innerText.toLowerCase();
        if (text.includes("reached the end of the list") || text.includes("no more results") || text.includes("you've reached the end")) {
          reachedEnd = true;
          break;
        }
      }
    }
    if (reachedEnd) {
      console.log("Reached the end of Google Maps listings feed.");
      break;
    }
  }
}

// Message Listener from Popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "scrapeCurrentPage") {
    const url = window.location.href;
    const isMaps = url.includes("google.com/maps") || (url.includes("google.co") && url.includes("/maps"));
    
    (async () => {
      try {
        if (request.autoScroll && isMaps) {
          await autoScrollGoogleMaps(request.maxResults || 50);
        }
      } catch (err) {
        console.error("Error during Maps auto-scroll:", err);
      }

      let results = [];
      if (isMaps) {
        results = scrapeGoogleMaps();
      } else if (url.includes("google.com") || url.includes("google.co")) {
        results = scrapeGoogleSearch();
      }

      // De-duplicate results by Name + Phone
      const uniqueMap = new Map();
      results.forEach(item => {
        const key = `${item.name.toLowerCase()}_${item.phone.toLowerCase()}`;
        if (!uniqueMap.has(key)) {
          uniqueMap.set(key, item);
        }
      });

      sendResponse({
        listings: Array.from(uniqueMap.values()),
        url: url,
        title: document.title
      });
    })();

    return true; // Keep message port open for async response
  }
});
