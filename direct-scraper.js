import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

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

// Extract brand from URL or product name
function extractBrand(url, name) {
  // First try to extract from URL path
  const urlMatch = url.match(/gsmarena\.com\/([a-z0-9-]+)-/i);
  if (urlMatch) {
    return urlMatch[1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }
  
  // Fallback: extract from product name (first word)
  const nameParts = name.split(' ');
  if (nameParts.length > 0) {
    return nameParts[0];
  }
  
  return "Unknown";
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
      const filename = `${debugDir}/snapshot-${Date.now()}-${extractProductId(url) || 'product'}.html`;
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

// Parse product page to extract structured data
function parseProductPage(html, url) {
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
  
  // Extract brand from URL/name
  const brand = extractBrand(url, name);
  
  // Detect category using specs (reliable method)
  const category = detectCategory(specs, name);
  
  return {
    id: extractProductId(url),
    name,
    brand,
    category,
    launchYear,
    image,
    url, // Add the product URL
    specs,
    scrapedAt: new Date().toISOString()
  };
}

// =========================
// DIRECT SCRAPING FUNCTION
// =========================

// Scrape individual product page
async function scrapeProduct(productUrl, seenProducts) {
  const productId = extractProductId(productUrl);
  if (!productId) {
    throw new Error(`Could not extract product ID from URL: ${productUrl}`);
  }
  
  // Check if we've already seen this product
  if (seenProducts[productId]) {
    console.log(`⏭️  Skipping already seen product: ${productId}`);
    return null;
  }
  
  try {
    console.log(`🔍 Scraping product: ${productUrl}`);
    const html = await fetchWithScraperAPI(productUrl);
    const product = parseProductPage(html, productUrl);
    
    // Validate launch year
    if (product.launchYear < MIN_LAUNCH_YEAR) {
      console.log(`⏭️  Skipping old product (${product.launchYear}): ${product.name}`);
      return null;
    }
    
    // Mark as seen
    seenProducts[productId] = {
      id: productId,
      name: product.name,
      scrapedAt: product.scrapedAt
    };
    
    console.log(`✅ Successfully scraped: ${product.name} (${product.launchYear}) - ${product.brand}`);
    return product;
    
  } catch (error) {
    if (error.message.includes("BLOCK_DETECTED")) {
      console.error("🚨 BLOCK DETECTED - Stopping scraper immediately");
      throw error;
    }
    console.error(`❌ Error scraping product ${productUrl}: ${error.message}`);
    return null;
  }
}

// =========================
// MAIN SCRAPING FUNCTION
// =========================

// Product URLs to scrape - Add your direct product page URLs here
const PRODUCT_URLS = [
  // Example URLs - Replace with your actual product page URLs
  "https://www.gsmarena.com/apple_iphone_15_pro_max-12650.php",
  "https://www.gsmarena.com/samsung_galaxy_s24_ultra-5989.php",
  "https://www.gsmarena.com/xiaomi_14_pro-12258.php",
  // Add more URLs as needed
];

// Main scraping function
async function runDirectScraper() {
  console.log("🚀 Starting GSMArena Direct URL Scraper");
  console.log(`📅 Only scraping products from ${MIN_LAUNCH_YEAR} or later`);
  console.log(`⏱️  Random delays: ${MIN_DELAY/1000}s - ${MAX_DELAY/1000}s`);
  console.log(`📋 Processing ${PRODUCT_URLS.length} product URLs`);
  
  // Load state
  const seenProducts = loadSeenProducts();
  console.log(`📚 Loaded ${Object.keys(seenProducts).length} previously seen products`);
  
  const allScrapedProducts = [];
  
  try {
    for (const productUrl of PRODUCT_URLS) {
      try {
        const product = await scrapeProduct(productUrl, seenProducts);
        if (product) {
          allScrapedProducts.push(product);
          // Save comprehensive JSON with all specs
          appendScrapedProduct(product);
        }
        
        // Random delay between requests
        await randomDelay();
        
      } catch (error) {
        if (error.message.includes("BLOCK_DETECTED")) {
          console.error("🛑 BLOCK DETECTED - Emergency stop activated");
          console.error(`💰 Credits used before blocking: ${creditsUsed}`);
          throw error;
        }
        console.error(`❌ Failed to process ${productUrl}: ${error.message}`);
      }
    }
    
    // Save state
    saveSeenProducts(seenProducts);
    
    // Final summary
    console.log(`\n✅ Scraping completed successfully!`);
    console.log(`📊 Total products scraped: ${allScrapedProducts.length}`);
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

// Check if PRODUCT_URLS array is empty
if (PRODUCT_URLS.length === 0) {
  console.error("❌ No product URLs provided!");
  console.error("Please add product page URLs to the PRODUCT_URLS array in the script.");
  process.exit(1);
}

// Run the scraper
runDirectScraper().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
