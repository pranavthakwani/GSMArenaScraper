import axios from "axios";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import * as cheerio from "cheerio";

// Load environment variables
dotenv.config();

// ================= CONFIG =================

const SCRAPER_API_KEY = process.env.SCRAPERAPI_KEY;
const AMAZON_DOMAIN = "amazon.com"; // change if needed
const OUTPUT_DIR = "amazon_image_results";
const MIN_MATCH_SCORE = 0.3;

if (!SCRAPER_API_KEY) {
  console.error("❌ SCRAPERAPI_KEY missing");
  process.exit(1);
}

// ================= YOUR PRODUCTS ARRAY =================
// Read product URLs from .env file
// Add your URLs to .env like: PRODUCT_URLS=https://amazon.com/dp/ASIN1,https://amazon.com/dp/ASIN2,...
const productUrls = process.env.PRODUCT_URLS ? 
  process.env.PRODUCT_URLS.split(',').map(url => url.trim()).filter(url => url) : [];

const products = productUrls.map(url => ({ url }));

// ================= UTIL =================

function saveResult(productName, data) {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const safeName = productName.replace(/[^\w]/g, "_");
  const filePath = path.join(OUTPUT_DIR, `${safeName}.json`);

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`💾 Saved → ${filePath}`);
}

// ================= SCRAPER =================

async function getAmazonProductHtml(url) {
  const scraperUrl = `https://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(url)}`;
  
  const response = await axios.get(scraperUrl);
  return response.data;
}

function extractAllHighResImages(html) {
  const hiResMatches = [...html.matchAll(/"hiRes":"(https:[^"]+)"/g)];

  if (hiResMatches.length > 0) {
    const hiResUrls = hiResMatches.map(match =>
      match[1].replace(/\\u0026/g, "&")
    );
    // Remove duplicates while preserving order
    const uniqueUrls = [...new Set(hiResUrls)];
    console.log(`Found ${uniqueUrls.length} unique hiRes images from colorImages`);
    return uniqueUrls;
  }

  // Fallback to dynamic image
  console.log('No hiRes found, falling back to dynamic image extraction');
  return extractHighResImages(html);
}

function extractHighResImages(html) {
  const $ = cheerio.load(html);
  const allImageUrls = new Set();

  // 1. Try main landing image
  const landingImg = $("#landingImage");
  const landingData = landingImg.attr("data-a-dynamic-image");
  if (landingData) {
    try {
      const json = JSON.parse(landingData.replace(/'/g, '"'));
      Object.keys(json).forEach(url => allImageUrls.add(url));
    } catch (err) {
      // Continue to other methods
    }
  }

  // 2. Try alternative image containers
  const altSelectors = [
    "#imgTagWrapperId img[data-a-dynamic-image]",
    "#main-image-container img[data-a-dynamic-image]",
    ".itemNo0 .a-dynamic-image-container img[data-a-dynamic-image]",
    ".a-dynamic-image-container img[data-a-dynamic-image]",
    "img[data-a-dynamic-image]"
  ];

  altSelectors.forEach(selector => {
    $(selector).each((i, elem) => {
      const dynamicData = $(elem).attr("data-a-dynamic-image");
      if (dynamicData) {
        try {
          const json = JSON.parse(dynamicData.replace(/'/g, '"'));
          Object.keys(json).forEach(url => allImageUrls.add(url));
        } catch (err) {
          // Skip invalid JSON
        }
      }
    });
  });

  // 3. Look for thumbnail images that might have full-size versions
  const thumbnailSelectors = [
    ".a-spacing-small .imgTagWrapper img",
    ".a-button-thumbnail img",
    ".thumbnail-grid img",
    ".imageThumbnail img",
    "#altImages img"
  ];

  thumbnailSelectors.forEach(selector => {
    $(selector).each((i, elem) => {
      const src = $(elem).attr("src") || $(elem).attr("data-src");
      if (src && src.includes("m.media-amazon.com/images/I/")) {
        // Convert thumbnail to full-size URL
        const fullSizeUrl = src
          .replace(/_S[XY]\d+_/, "._SL1500_")
          .replace(/_S\d+_/, "._SL1500_")
          .replace(/_AC_S[XY]\d+_/, "._SL1500_")
          .replace(/_AC_S\d+_/, "._SL1500_");
        allImageUrls.add(fullSizeUrl);
      }
    });
  });

  // 4. Look for image data in JavaScript variables
  const scriptTags = $("script");
  scriptTags.each((i, elem) => {
    const scriptContent = $(elem).html();
    if (scriptContent && scriptContent.includes("colorImages")) {
      try {
        // Try to extract colorImages data
        const colorImagesMatch = scriptContent.match(/'colorImages':\s*{[^}]+}/);
        if (colorImagesMatch) {
          const colorImagesStr = colorImagesMatch[0].replace(/'/g, '"');
          const colorImagesMatch2 = colorImagesStr.match(/"initial":\s*(\[.*?\])/);
          if (colorImagesMatch2) {
            const imageData = JSON.parse(colorImagesMatch2[1]);
            imageData.forEach(img => {
              if (img.large) allImageUrls.add(img.large);
              if (img.thumb) {
                const fullSize = img.thumb.replace(/_S[XY]\d+_/, "._SL1500_");
                allImageUrls.add(fullSize);
              }
            });
          }
        }
      } catch (err) {
        // Continue
      }
    }
  });

  console.log(`Found ${allImageUrls.size} total image URLs`);
  return optimizeImageUrls(Array.from(allImageUrls));
}

function optimizeImageUrls(urls) {
  const uniqueBaseIds = new Set();
  
  // Extract base image IDs from URLs
  urls.forEach(url => {
    const match = url.match(/images\/I\/([A-Za-z0-9\-]+)\./);
    if (match) {
      uniqueBaseIds.add(match[1]);
    }
  });
  
  // Convert each base ID to high-resolution _SL1500_ URL
  return Array.from(uniqueBaseIds).map(baseId => 
    `https://m.media-amazon.com/images/I/${baseId}._SL1500_.jpg`
  );
}

function extractProductInfo(html) {
  const $ = cheerio.load(html);
  
  // Extract product title
  const title = $("#productTitle").text().trim() || 
               $("h1.a-size-large").first().text().trim() ||
               $(".product-title").first().text().trim();
  
  // Extract ASIN from URL or meta tags
  let asin = "";
  const asinMatch = html.match(/\/dp\/([A-Z0-9]{10})/);
  if (asinMatch) {
    asin = asinMatch[1];
  } else {
    const asinMeta = $('input[name="ASIN"]').val() || 
                    $("meta[name='ASIN']").attr("content") ||
                    $("#ASIN").val();
    asin = asinMeta || "";
  }
  
  return { title: title || "Unknown Product", asin };
}

async function main() {
  console.log(`🚀 Starting Amazon image scraper for ${products.length} products...`);
  
  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    console.log(`\n🔎 Processing product ${i + 1}/${products.length}: ${product.url}`);
    
    try {
      const html = await getAmazonProductHtml(product.url);
      const images = extractAllHighResImages(html);
      const productInfo = extractProductInfo(html);
      
      // Generate filename from product title
      const filename = productInfo.title
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "_")
        .substring(0, 50);
      
      saveResult(filename, {
        status: "SUCCESS",
        url: product.url,
        asin: productInfo.asin,
        amazon_title: productInfo.title,
        image_count: images.length,
        images
      });
      
      console.log(`✅ Successfully scraped ${images.length} images`);
      
    } catch (err) {
      console.error(`❌ Error with ${product.url}: ${err.message}`);
      
      const filename = `error_${Date.now()}`;
      saveResult(filename, {
        status: "ERROR",
        url: product.url,
        error: err.message,
        images: []
      });
    }
    
    // Rate limiting
    if (i < products.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  console.log("\n🎯 Done.");
}

main();
