import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';
import sql from 'mssql';
import cors from 'cors';

// Load environment variables
dotenv.config();

// =========================
// CONFIGURATION
// =========================

const app = express();
const PORT = process.env.PORT || 6000;
const BASE = "https://www.gsmarena.com";
const API_KEY = process.env.SCRAPERAPI_KEY;
const MIN_DELAY = 1000; // 1 second for API (faster than batch scraping)
const MAX_DELAY = 3000; // 3 seconds maximum
const MIN_LAUNCH_YEAR = 1900; // No limit - scrape all products
const REQUEST_TIMEOUT = 30000;
const MAX_CREDITS = 950;

// Database configuration
const dbConfig = {
  user: 'KORE',
  password: 'Kore@321',
  server: '182.16.16.30',
  database: 'KORE',
  port: 1433,
  options: {
    encrypt: false,
    enableArithAbort: true,
    trustServerCertificate: true,
    requestTimeout: 600000
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

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

// Credit tracking
let creditsUsed = 0;

// =========================
// MIDDLEWARE
// =========================

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  // Ignore socket.io requests
  if (req.url.includes('/socket.io/')) {
    return next();
  }
  
  const timestamp = new Date().toISOString();
  const clientIP = req.ip || req.connection.remoteAddress;
  console.log(`[${timestamp}] ${req.method} ${req.url} - IP: ${clientIP}`);
  next();
});

// =========================
// STATE MANAGEMENT
// =========================

const STATE_FILE = "seen_products.json";
const OUTPUT_DIR = "scraped_products";

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

// Validate GSM Arena URL
function isValidGSMArenaURL(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname === 'www.gsmarena.com' && 
           urlObj.pathname.includes('.php') &&
           extractProductId(url) !== null;
  } catch {
    return false;
  }
}

// Detect if page is blocked
function isBlocked(html) {
  const lowerHtml = html.toLowerCase();
  return BLOCK_KEYWORDS.some(keyword => lowerHtml.includes(keyword));
}

// Extract launch year from specs
function extractLaunchYear(specs) {
  const launchSpec = specs["Launch"] || {};
  const announced = launchSpec["Announced"] || "";
  
  const yearMatch = announced.match(/\b(20\d{2})\b/);
  if (yearMatch) {
    return parseInt(yearMatch[1]);
  }
  
  return null;
}

// Detect product category using spec sections (only when certain)
function detectCategory(specs, name) {
  const hasDisplay = specs["Display"] && Object.keys(specs["Display"]).length > 0;
  const hasBattery = specs["Battery"] && Object.keys(specs["Battery"]).length > 0;
  const hasSIM = specs["SIM"] && Object.keys(specs["SIM"]).length > 0;
  const hasSound = specs["Sound"] && Object.keys(specs["Sound"]).length > 0;
  const hasBody = specs["Body"] && Object.keys(specs["Body"]).length > 0;
  
  // Only categorize when we have sufficient data
  if (hasSound && !hasDisplay && !hasSIM) {
    return "earbuds";
  }
  
  if (hasDisplay && hasBattery && !hasSIM) {
    const lowerName = name.toLowerCase();
    if (lowerName.includes("watch") || lowerName.includes("smartwatch")) {
      return "watch";
    }
    return "tablet";
  }
  
  if (hasDisplay && hasBattery && hasSIM) {
    return "phone";
  }
  
  if (!hasDisplay && !hasBattery && !hasSIM && !hasSound && hasBody) {
    return "accessory";
  }
  
  // If insufficient data, return null instead of guessing
  return null;
}

// Extract brand from URL or product name
function extractBrand(url, name) {
  const urlMatch = url.match(/gsmarena\.com\/([a-z0-9-]+)-/i);
  if (urlMatch) {
    return urlMatch[1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }
  
  const nameParts = name.split(' ');
  if (nameParts.length > 0) {
    return nameParts[0];
  }
  
  return "Unknown";
}

// =========================
// SCRAPERAPI LAYER
// =========================

async function fetchWithScraperAPI(url) {
  creditsUsed++;
  
  if (creditsUsed >= MAX_CREDITS) {
    throw new Error("Credit limit reached. Please try again later.");
  }
  
  if (!API_KEY) {
    throw new Error("SCRAPERAPI_KEY not configured");
  }
  
  const encodedUrl = encodeURIComponent(url);
  const apiUrl = `https://api.scraperapi.com/?api_key=${API_KEY}&url=${encodedUrl}&render=false`;
  
  try {
    const response = await axios.get(apiUrl, {
      timeout: REQUEST_TIMEOUT,
      validateStatus: (status) => status >= 200 && status < 500
    });
    
    if (isBlocked(response.data)) {
      throw new Error("BLOCK_DETECTED: Page contains blocking indicators");
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

function parseProductPage(html, url) {
  const $ = cheerio.load(html);
  
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
  
  const launchYear = extractLaunchYear(specs);
  if (!launchYear) {
    throw new Error("Could not extract launch year from Launch.Announced");
  }
  
  const brand = extractBrand(url, name);
  const category = detectCategory(specs, name);
  
  return {
    id: extractProductId(url),
    name,
    brand,
    category,
    launchYear,
    image,
    url,
    specs,
    scrapedAt: new Date().toISOString()
  };
}

// =========================
// DATABASE FUNCTIONS
// =========================

async function uploadToDatabase(product) {
  const pool = await sql.connect(dbConfig);
  
  try {
    // Send data in the format expected by stored procedure
    // Include both nested specs and flattened fields for compatibility
    const brandData = [{
      ...product,  // Keep original nested structure
      GSMAERANLINK: product.url  // Add GSM Arena link
    }];
    const jsonString = JSON.stringify(brandData);
    
    console.log(`📤 Uploading to database with GSMAERANLINK: ${product.url}`);
    console.log(`📋 Complete JSON sent to DB:`, jsonString);
    
    await pool.request()
      .input('json', sql.NVarChar(sql.MAX), jsonString)
      .execute('SP_WT_SCM_ItemsSpecs_Insert');
    
    console.log(`✅ Uploaded ${product.name} to database`);
    
    // Query back to verify GSMAERANLINK was stored
    const verifyResult = await pool.request()
      .input('id', sql.NVarChar, product.id)
      .query('SELECT TOP 1 GSMAERANLINK FROM WT_SCM_ItemsSpecs WHERE id = @id');
    
    if (verifyResult.recordset.length > 0) {
      console.log(`✅ GSMAERANLINK in database: ${verifyResult.recordset[0].GSMAERANLINK}`);
    } else {
      console.log(`❌ GSMAERANLINK NOT FOUND in database for ID: ${product.id}`);
    }
    
    return true;
    
  } catch (error) {
    console.error(`❌ Database upload failed for ${product.name}:`, error.message);
    throw error;
  } finally {
    await pool.close();
  }
}

// =========================
// SCRAPING LOGIC
// =========================

async function scrapeProduct(productUrl, seenProducts) {
  const productId = extractProductId(productUrl);
  if (!productId) {
    throw new Error(`Could not extract product ID from URL: ${productUrl}`);
  }
  
  // Check if already seen
  if (seenProducts[productId]) {
    return { success: false, message: "Product already scraped" };
  }
  
  try {
    console.log(`🔍 Scraping product: ${productUrl}`);
    const html = await fetchWithScraperAPI(productUrl);
    const product = parseProductPage(html, productUrl);
    
    // No launch year validation - scrape all products
    
    // Mark as seen
    seenProducts[productId] = {
      id: productId,
      name: product.name,
      scrapedAt: product.scrapedAt
    };
    
    // Save to local file
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    
    const brandFile = path.join(OUTPUT_DIR, `${product.brand.toLowerCase()}.json`);
    let brandProducts = [];
    
    if (fs.existsSync(brandFile)) {
      const data = fs.readFileSync(brandFile, "utf8");
      brandProducts = JSON.parse(data);
    }
    
    brandProducts.push(product);
    brandProducts.sort((a, b) => b.launchYear - a.launchYear);
    fs.writeFileSync(brandFile, JSON.stringify(brandProducts, null, 2));
    
    // Upload to database
    await uploadToDatabase(product);
    
    console.log(`✅ Successfully scraped and stored: ${product.name}`);
    console.log(`📋 Full scraped data:`, JSON.stringify(product, null, 2));
    console.log(`💾 Data uploaded to database with GSMAERANLINK: ${product.url}`);
    
    return { 
      success: true, 
      product: product  // Return complete product object
    };
    
  } catch (error) {
    if (error.message.includes("BLOCK_DETECTED")) {
      throw new Error("Scraping blocked - please try again later");
    }
    throw new Error(`Scraping failed: ${error.message}`);
  }
}

// =========================
// API ENDPOINTS
// =========================

// Health check endpoint
app.get('/health', (req, res) => {
  console.log(`📊 Health check requested from IP: ${req.ip}`);
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    creditsUsed,
    maxCredits: MAX_CREDITS
  });
});

// Main scraping endpoint
app.post('/scrape', async (req, res) => {
  const { productUrl } = req.body;
  
  console.log(`🔍 Scrape request received from IP: ${req.ip}`);
  console.log(`📱 Product URL: ${productUrl}`);
  
  if (!productUrl) {
    console.log(`❌ Missing productUrl in request`);
    return res.status(400).json({
      success: false,
      message: "productUrl is required"
    });
  }
  
  if (!isValidGSMArenaURL(productUrl)) {
    console.log(`❌ Invalid GSM Arena URL: ${productUrl}`);
    return res.status(400).json({
      success: false,
      message: "Invalid GSM Arena product URL"
    });
  }
  
  const seenProducts = loadSeenProducts();
  
  try {
    const result = await scrapeProduct(productUrl, seenProducts);
    
    if (result.success) {
      saveSeenProducts(seenProducts);
      console.log(`✅ Successfully scraped and stored: ${result.product.name}`);
      return res.json({
        success: true,
        message: "Product scraped and stored successfully in database",
        data: result.product,
        fullData: {
          ...result.product,
          GSMAERANLINK: result.product.url
        }
      });
    } else {
      console.log(`⚠️  Scrape issue: ${result.message}`);
      return res.status(400).json({
        success: false,
        message: result.message
      });
    }
    
  } catch (error) {
    console.error('Scraping error:', error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Bulk scraping endpoint
app.post('/scrape-bulk', async (req, res) => {
  const { productUrls } = req.body;
  
  console.log(`📦 Bulk scrape request received from IP: ${req.ip}`);
  console.log(`📋 Number of URLs: ${productUrls ? productUrls.length : 0}`);
  
  if (!productUrls || !Array.isArray(productUrls)) {
    console.log(`❌ Invalid productUrls array`);
    return res.status(400).json({
      success: false,
      message: "productUrls array is required"
    });
  }
  
  // Validate all URLs
  const invalidUrls = productUrls.filter(url => !isValidGSMArenaURL(url));
  if (invalidUrls.length > 0) {
    console.log(`❌ Invalid URLs found: ${invalidUrls.join(', ')}`);
    return res.status(400).json({
      success: false,
      message: `Invalid URLs found: ${invalidUrls.join(', ')}`
    });
  }
  
  const seenProducts = loadSeenProducts();
  const results = [];
  
  try {
    for (const url of productUrls) {
      try {
        const result = await scrapeProduct(url, seenProducts);
        results.push({ url, ...result });
        await randomDelay(); // Delay between requests
      } catch (error) {
        results.push({ url, success: false, message: error.message });
      }
    }
    
    saveSeenProducts(seenProducts);
    
    const successCount = results.filter(r => r.success).length;
    
    console.log(`📊 Bulk scraping completed: ${successCount}/${productUrls.length} successful`);
    
    return res.json({
      success: true,
      message: `Processed ${productUrls.length} URLs, ${successCount} successful`,
      results
    });
    
  } catch (error) {
    console.error('Bulk scraping error:', error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// =========================
// ERROR HANDLING
// =========================

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found'
  });
});

// =========================
// IP DETECTION FUNCTIONS
// =========================

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  
  return "localhost";
}

async function getPublicIP() {
  try {
    const res = await axios.get("https://api.ipify.org?format=json");
    return res.data.ip;
  } catch {
    return null;
  }
}

// =========================
// START SERVER
// =========================

if (!API_KEY) {
  console.error("❌ SCRAPERAPI_KEY environment variable is required!");
  process.exit(1);
}

app.listen(PORT, '0.0.0.0', async () => {
  const localIP = getLocalIP();
  const publicIP = await getPublicIP();
  
  console.log(`🚀 GSM Arena Scraper API running on port ${PORT}`);
  console.log(`📅 Scraping all products (no year limit)`);
  
  console.log(`🌐 Local access: http://localhost:${PORT}`);
  console.log(`🌐 Network access: http://${localIP}:${PORT}`);
  
  if (publicIP) {
    console.log(`🌐 External access: http://${publicIP}:${PORT}`);
  }
  
  console.log(`📊 Health check: GET http://${localIP}:${PORT}/health`);
  console.log(`🔍 Single scrape: POST http://${localIP}:${PORT}/scrape`);
  console.log(`📦 Bulk scrape: POST http://${localIP}:${PORT}/scrape-bulk`);
  console.log(`💰 Credits limit: ${MAX_CREDITS}`);
});

export default app;
