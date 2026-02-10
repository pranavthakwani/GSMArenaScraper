import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import XLSX from "xlsx";

// Load environment variables from .env file
dotenv.config();

// =========================
// CONFIGURATION
// =========================

const BASE = "https://www.gsmarena.com";
const API_KEY = process.env.SCRAPERAPI_KEY; // Required: Set in .env file
const MIN_DELAY = 3000; // 3 seconds minimum
const MAX_DELAY = 8000; // 8 seconds maximum
const MIN_LAUNCH_YEAR = 2023; // Only scrape products from 2023 or later
const REQUEST_TIMEOUT = 30000; // 30 seconds timeout
const SAVE_HTML_SNAPSHOTS = process.env.SAVE_HTML === 'true'; // Optional: Set to 'true' for debugging
const MAX_CREDITS = 950; // Safety limit to prevent over-burn

// Block detection keywords
const BLOCK_KEYWORDS = [
  "captcha",
  "access denied",
  "unusual traffic",
  "blocked",
  "forbidden",
  "rate limit",
  "too many requests"
];

// Credit tracking (per request)
let creditsUsed = 0;

// =========================
// STATE MANAGEMENT
// =========================

const STATE_FILE = "seen_products.json";
const OUTPUT_DIR = "scraped_products"; // Directory for brand-specific JSON files

// Load previously seen product IDs
function loadSeenProducts() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.warn("Warning: Could not load seen_products.json, starting fresh");
  }
  return {};
}

// Save seen product IDs
function saveSeenProducts(seenProducts) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(seenProducts, null, 2));
  } catch (error) {
    console.error("Error saving seen_products.json:", error.message);
  }
}

// Save scraped products to brand-specific JSON files
function appendScrapedProduct(product) {
  try {
    // Create output directory if it doesn't exist
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    
    // Create brand-specific filename
    const brandFile = path.join(OUTPUT_DIR, `${product.brand.toLowerCase()}.json`);
    
    // Load existing products for this brand
    let brandProducts = [];
    if (fs.existsSync(brandFile)) {
      const data = fs.readFileSync(brandFile, "utf8");
      brandProducts = JSON.parse(data);
    }
    
    // Add new product
    brandProducts.push(product);
    
    // Sort by launch year (newest first)
    brandProducts.sort((a, b) => b.launchYear - a.launchYear);
    
    // Save brand-specific file
    fs.writeFileSync(brandFile, JSON.stringify(brandProducts, null, 2));
    console.log(`✅ Saved ${product.name} to ${brandFile}`);
  } catch (error) {
    console.error("Error saving product:", error.message);
  }
}


// =========================
// UTILITY FUNCTIONS
// =========================

// Random delay between requests
function randomDelay() {
  const delay = Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1)) + MIN_DELAY;
  return new Promise(resolve => setTimeout(resolve, delay));
}

// Extract product ID from URL
function extractProductId(url) {
  const match = url.match(/-(\d+)\.php$/);
  return match ? match[1] : null;
}

// Detect if page is blocked
function isBlocked(html) {
  const lowerHtml = html.toLowerCase();
  return BLOCK_KEYWORDS.some(keyword => lowerHtml.includes(keyword));
}

// Extract launch year from specs (NO FALLBACK - only use Launch.Announced)
function extractLaunchYear(specs) {
  // Look for Launch section
  const launchSpec = specs["Launch"] || {};
  const announced = launchSpec["Announced"] || "";
  
  // Extract year using regex
  const yearMatch = announced.match(/\b(20\d{2})\b/);
  if (yearMatch) {
    return parseInt(yearMatch[1]);
  }
  
  // No fallback - if Launch.Announced is missing or invalid, skip product
  return null;
}

// Detect product category using spec sections (reliable method)
function detectCategory(specs, name) {
  const hasDisplay = specs["Display"] && Object.keys(specs["Display"]).length > 0;
  const hasBattery = specs["Battery"] && Object.keys(specs["Battery"]).length > 0;
  const hasSIM = specs["SIM"] && Object.keys(specs["SIM"]).length > 0;
  const hasSound = specs["Sound"] && Object.keys(specs["Sound"]).length > 0;
  const hasBody = specs["Body"] && Object.keys(specs["Body"]).length > 0;
  
  // Earbuds: Sound but no Display, no SIM
  if (hasSound && !hasDisplay && !hasSIM) {
    return "earbuds";
  }
  
  // Tablets/Watch: Display + Battery but no SIM
  if (hasDisplay && hasBattery && !hasSIM) {
    // Further distinguish by size indicators in name
    const lowerName = name.toLowerCase();
    if (lowerName.includes("watch") || lowerName.includes("smartwatch")) {
      return "watch";
    }
    return "tablet";
  }
  
  // Phone: Display + Battery + SIM (most common case)
  if (hasDisplay && hasBattery && hasSIM) {
    return "phone";
  }
  
  // Accessories: Minimal specs, often just Body or single category
  if (!hasDisplay && !hasBattery && !hasSIM && !hasSound && hasBody) {
    return "accessory";
  }
  
  // Default fallback
  return "phone";
}

// =========================
// SCRAPERAPI LAYER
// =========================

// Make request through ScraperAPI
async function fetchWithScraperAPI(url, isErrorSnapshot = false) {
  creditsUsed++; // Track credit usage per request
  
  // Safety check: prevent credit over-burn
  if (creditsUsed >= MAX_CREDITS) {
    console.error(`🛑 Credit limit reached (${MAX_CREDITS}). Stopping safely to prevent over-burn.`);
    process.exit(0);
  }
  
  if (!API_KEY) {
    throw new Error("SCRAPERAPI_KEY environment variable is required");
  }
  
  const encodedUrl = encodeURIComponent(url);
  const apiUrl = `https://api.scraperapi.com/?api_key=${API_KEY}&url=${encodedUrl}&render=false`;
  
  try {
    const response = await axios.get(apiUrl, {
      timeout: REQUEST_TIMEOUT,
      validateStatus: (status) => status >= 200 && status < 500
    });
    
    // Check for blocking
    if (isBlocked(response.data)) {
      throw new Error("BLOCK_DETECTED: Page contains blocking indicators");
    }
    
    // Save HTML snapshot only when explicitly enabled (never on errors)
    if (SAVE_HTML_SNAPSHOTS && !isErrorSnapshot) {
      const debugDir = "debug";
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir);
      }
      const filename = `${debugDir}/snapshot-${Date.now()}-${extractProductId(url) || 'listing'}.html`;
      fs.writeFileSync(filename, response.data);
      console.log(`📸 Saved HTML snapshot: ${filename}`);
    }
    
    return response.data;
  } catch (error) {
    if (error.message.includes("BLOCK_DETECTED")) {
      throw error;
    }
    throw new Error(`ScraperAPI request failed: ${error.message}`);
  }
}

// =========================
// PARSING LAYER
// =========================

// Parse brand listing page to extract product links
function parseBrandListing(html) {
  const $ = cheerio.load(html);
  const links = [];
  
  $(".makers li a").each((_, el) => {
    const href = $(el).attr("href");
    if (href?.endsWith(".php")) {
      const fullUrl = `${BASE}/${href}`;
      const productId = extractProductId(fullUrl);
      if (productId) {
        links.push({ url: fullUrl, id: productId });
      }
    }
  });
  
  return links;
}

// Parse product page to extract structured data
function parseProductPage(html, url, brand) {
  const $ = cheerio.load(html);
  
  // Basic info
  const name = $("h1").text().trim();
  if (!name) {
    throw new Error("Could not extract product name");
  }
  
  const image = $(".specs-photo-main img").attr("src") || null;
  
  // Parse specs into nested object structure
  const specs = {};
  $("#specs-list table").each((_, table) => {
    const section = $(table).find("th").first().text().trim();
    if (!section) return;
    
    specs[section] = {};
    $(table).find("tr").each((_, row) => {
      const key = $(row).find(".ttl").text().trim();
      const val = $(row).find(".nfo").text().trim();
      if (key && val) {
        specs[section][key] = val;
      }
    });
  });
  
  // Extract launch year (strict - no fallback)
  const launchYear = extractLaunchYear(specs);
  if (!launchYear) {
    throw new Error("Could not extract launch year from Launch.Announced");
  }
  
  // Detect category using specs (reliable method)
  const category = detectCategory(specs, name);
  
  return {
    id: extractProductId(url),
    name,
    brand, // Use passed brand from seed loop
    category,
    launchYear,
    image,
    url, // Add the product URL
    specs,
    scrapedAt: new Date().toISOString()
  };
}

// =========================
// INCREMENTAL SCRAPING LOGIC
// =========================

// Get all product links from brand pages (with pagination)
async function getBrandProductLinks(brandUrl, seenProducts) {
  const match = brandUrl.match(/\/([a-z0-9-]+)-(phones|tablets|watch|earbuds)-(\d+)\.php/i);
  if (!match) throw new Error(`Invalid brand URL: ${brandUrl}`);
  
  const slug = match[1];
  const type = match[2]; // phones, tablets, watch, earbuds
  const id = match[3];
  let page = 1;
  const allNewLinks = [];
  let consecutiveOldPages = 0; // Optimization: track pages with only old products
  
  while (true) {
    const url = page === 1 
      ? `${BASE}/${slug}-${type}-${id}.php`
      : `${BASE}/${slug}-${type}-f-${id}-0-p${page}.php`;
    
    console.log(`Fetching ${brandUrl} page ${page}...`);
    
    try {
      const html = await fetchWithScraperAPI(url);
      const links = parseBrandListing(html);
      
      // Stop pagination only when page is completely empty
      if (!links.length) {
        console.log(`No products found on page ${page} - stopping pagination`);
        break;
      }
      
      // Filter for new products only
      const newLinks = links.filter(link => !seenProducts[link.id]);
      
      allNewLinks.push(...newLinks);
      console.log(`Found ${links.length} total products, ${newLinks.length} new on page ${page}`);
      
      // Optimization: if page has no new products, increment counter
      if (newLinks.length === 0) {
        consecutiveOldPages++;
        // Optional: stop after many consecutive pages with no new products
        if (consecutiveOldPages >= 3) {
          console.log(`No new products for ${consecutiveOldPages} consecutive pages - stopping pagination (optimization)`);
          break;
        }
      } else {
        consecutiveOldPages = 0; // Reset counter when we find new products
      }
      
      page++;
      await randomDelay();
      
    } catch (error) {
      if (error.message.includes("BLOCK_DETECTED")) {
        console.error("BLOCK DETECTED - Stopping scraper immediately");
        throw error;
      }
      console.error(`Error fetching page ${page}:`, error.message);
      break;
    }
  }
  
  return allNewLinks;
}

// Scrape individual product page
async function scrapeProduct(productUrl, seenProducts, brand) {
  const productId = extractProductId(productUrl);
  if (!productId) {
    throw new Error(`Could not extract product ID from URL: ${productUrl}`);
  }
  
  // Double-check we haven't seen this product
  if (seenProducts[productId]) {
    console.log(`Skipping already seen product: ${productId}`);
    return null;
  }
  
  try {
    console.log(`Scraping product: ${productUrl}`);
    const html = await fetchWithScraperAPI(productUrl);
    const product = parseProductPage(html, productUrl, brand);
    
    // Validate launch year
    if (product.launchYear < MIN_LAUNCH_YEAR) {
      console.log(`Skipping old product (${product.launchYear}): ${product.name}`);
      return null;
    }
    
    // Mark as seen
    seenProducts[productId] = {
      id: productId,
      name: product.name,
      scrapedAt: product.scrapedAt
    };
    
    console.log(`Successfully scraped: ${product.name} (${product.launchYear})`);
    return product;
    
  } catch (error) {
    if (error.message.includes("BLOCK_DETECTED")) {
      console.error("BLOCK DETECTED - Stopping scraper immediately");
      throw error;
    }
    console.error(`Error scraping product ${productUrl}:`, error.message);
    return null;
  }
}

// =========================
// MAIN SCRAPING FUNCTION
// =========================

// Brands to scrape - ALL categories (phones, tablets, watches, earbuds)
const BRAND_CATEGORIES = [
  { name: "apple", url: "https://www.gsmarena.com/apple-phones-48.php", category: "phones" },
  { name: "samsung", url: "https://www.gsmarena.com/samsung-phones-9.php", category: "phones" },
  { name: "xiaomi", url: "https://www.gsmarena.com/xiaomi-phones-80.php", category: "phones" },
  { name: "oppo", url: "https://www.gsmarena.com/oppo-phones-82.php", category: "phones" },
  { name: "vivo", url: "https://www.gsmarena.com/vivo-phones-98.php", category: "phones" },
  { name: "google", url: "https://www.gsmarena.com/google-phones-107.php", category: "phones" },
  { name: "infinix", url: "https://www.gsmarena.com/infinix-phones-119.php", category: "phones" },
  { name: "tecno", url: "https://www.gsmarena.com/tecno-phones-120.php", category: "phones" },
  { name: "itel", url: "https://www.gsmarena.com/itel-phones-131.php", category: "phones" },
  { name: "nothing", url: "https://www.gsmarena.com/nothing-phones-128.php", category: "phones" },
  { name: "motorola", url: "https://www.gsmarena.com/motorola-phones-4.php", category: "phones" },
  { name: "realme", url: "https://www.gsmarena.com/realme-phones-118.php", category: "phones" },
  { name: "oneplus", url: "https://www.gsmarena.com/oneplus-phones-95.php", category: "phones" },
  { name: "asus", url: "https://www.gsmarena.com/asus-phones-46.php", category: "phones" },
  { name: "micromax", url: "https://www.gsmarena.com/micromax-phones-66.php", category: "phones" },
  { name: "nokia", url: "https://www.gsmarena.com/nokia-phones-1.php", category: "phones" },
  { name: "lenovo", url: "https://www.gsmarena.com/lenovo-phones-73.php", category: "phones" },
  { name: "honor", url: "https://www.gsmarena.com/honor-phones-121.php", category: "phones" },
  { name: "sony", url: "https://www.gsmarena.com/sony-phones-7.php", category: "phones" },
  // { name: "lg", url: "https://www.gsmarena.com/lg-phones-20.php", category: "phones" },
  // { name: "huawei", url: "https://www.gsmarena.com/huawei-phones-58.php", category: "phones" },
  // { name: "tcl", url: "https://www.gsmarena.com/tcl-phones-123.php", category: "phones" },
  // { name: "htc", url: "https://www.gsmarena.com/htc-phones-45.php", category: "phones" },
  // { name: "zte", url: "https://www.gsmarena.com/zte-phones-62.php", category: "phones" },
  // { name: "alcatel", url: "https://www.gsmarena.com/alcatel-phones-5.php", category: "phones" },
  // { name: "sharp", url: "https://www.gsmarena.com/sharp-phones-23.php", category: "phones" },
  // { name: "ulefone", url: "https://www.gsmarena.com/ulefone-phones-124.php", category: "phones" },
  // { name: "doogee", url: "https://www.gsmarena.com/doogee-phones-129.php", category: "phones" },
  // { name: "blackview", url: "https://www.gsmarena.com/blackview-phones-116.php", category: "phones" },
  // { name: "cubot", url: "https://www.gsmarena.com/cubot-phones-130.php", category: "phones" },
  // { name: "oukitel", url: "https://www.gsmarena.com/oukitel-phones-132.php", category: "phones" },
  // { name: "umidigi", url: "https://www.gsmarena.com/umidigi-phones-135.php", category: "phones" },
  // { name: "coolpad", url: "https://www.gsmarena.com/coolpad-phones-105.php", category: "phones" },
  // { name: "meizu", url: "https://www.gsmarena.com/meizu-phones-74.php", category: "phones" },
  // { name: "oscal", url: "https://www.gsmarena.com/oscal-phones-134.php", category: "phones" }
];

// Main scraping function
async function runIncrementalScraper() {
  console.log("🚀 Starting GSMArena Incremental Scraper");
  console.log(`📅 Only scraping products from ${MIN_LAUNCH_YEAR} or later`);
  console.log(`⏱️  Random delays: ${MIN_DELAY/1000}s - ${MAX_DELAY/1000}s`);
  
  // Load state
  const seenProducts = loadSeenProducts();
  console.log(`📚 Loaded ${Object.keys(seenProducts).length} previously seen products`);
  
  const allScrapedProducts = [];
  
  try {
    for (const brandCategory of BRAND_CATEGORIES) {
      console.log(`\n=== ${brandCategory.name.toUpperCase()} ${brandCategory.category.toUpperCase()} ===`);
      
      try {
        // Get new product links for this brand/category
        const newLinks = await getBrandProductLinks(brandCategory.url, seenProducts);
        console.log(`🆕 Found ${newLinks.length} new products for ${brandCategory.name} ${brandCategory.category}`);
        
        if (newLinks.length === 0) {
          console.log(`✅ No new products for ${brandCategory.name} ${brandCategory.category}`);
          continue;
        }
        
        // Scrape each new product
        let oldProductCount = 0; // Counter for consecutive old products
        for (const link of newLinks) {
          try {
            const product = await scrapeProduct(link.url, seenProducts, brandCategory.name);
            if (product) {
              allScrapedProducts.push(product);
              // Save comprehensive JSON with all specs
              appendScrapedProduct(product);
              oldProductCount = 0; // Reset counter on successful scrape
            } else {
              oldProductCount++;
              console.log(`⚠️  Old product count: ${oldProductCount}/3`);
              
              // Skip to next brand after 3 consecutive old products
              if (oldProductCount >= 3) {
                console.log(`🛑 Too many old products (${oldProductCount}), skipping to next brand: ${brandCategory.name}`);
                break;
              }
            }
            await randomDelay();
          } catch (error) {
            if (error.message.includes("BLOCK_DETECTED")) {
              throw error; // Propagate up to stop everything
            }
            console.error(`Failed to scrape ${link.url}:`, error.message);
          }
        }
        
        // Save state after each brand/category
        saveSeenProducts(seenProducts);
        
      } catch (error) {
        if (error.message.includes("BLOCK_DETECTED")) {
          console.error("🛑 BLOCK DETECTED - Emergency stop activated");
          console.error(`💰 Credits used before blocking: ${creditsUsed}`);
          throw error;
        }
        console.error(`Error processing ${brandCategory.name} ${brandCategory.category}:`, error.message);
      }
    }
    
    // Final save - brand-specific JSON files with all specs
    console.log(`\n✅ Scraping completed successfully!`);
    console.log(`📊 Total new products scraped: ${allScrapedProducts.length}`);
    console.log(`💰 Total ScraperAPI credits used: ${creditsUsed} (limit: ${MAX_CREDITS})`);
    console.log(`📚 Total products in database: ${Object.keys(seenProducts).length}`);
    console.log(`📄 Data saved to brand-specific JSON files in: ${OUTPUT_DIR}/`);
    console.log(`📋 Each brand has separate file: apple.json, samsung.json, xiaomi.json, etc.`);
    console.log(`📋 Contains ALL specs: Network, Display, Platform, Memory, Camera, Battery, etc.`);
    
  } catch (error) {
    if (error.message.includes("BLOCK_DETECTED")) {
      console.error("\n🚨 SCRAPER STOPPED DUE TO BLOCKING");
      console.error("🔒 This prevents consuming more credits on blocked requests");
      console.error("🔄 Run again later when the block is lifted");
    } else {
      console.error("\n❌ Unexpected error:", error.message);
    }
    
    // Save whatever we have
    saveSeenProducts(seenProducts);
    if (allScrapedProducts.length > 0) {
      console.log(`💾 Products saved to brand-specific JSON files in: ${OUTPUT_DIR}/`);
      console.log(`📋 Each brand has separate file: apple.json, samsung.json, xiaomi.json, etc.`);
      console.log(`📋 Contains ALL specs: Network, Display, Platform, Memory, Camera, Battery, etc.`);
    }
    
    process.exit(1);
  }
}

// =========================
// EXECUTION
// =========================

// Check for API key
if (!API_KEY) {
  console.error("❌ SCRAPERAPI_KEY environment variable is required!");
  console.error("Please set it in your .env file or environment:");
  console.error("export SCRAPERAPI_KEY=your_api_key_here");
  process.exit(1);
}

// Run the scraper
runIncrementalScraper().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
