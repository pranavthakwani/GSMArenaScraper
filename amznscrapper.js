import axios from "axios";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import * as cheerio from "cheerio";

// Load environment variables
dotenv.config();

// ================= CONFIG =================

const SCRAPER_API_KEY = process.env.SCRAPERAPI_KEY;
const AMAZON_DOMAIN = "amazon.in"; // change if needed
const OUTPUT_DIR = "amazon_image_results";
const MIN_MATCH_SCORE = 0.3;

if (!SCRAPER_API_KEY) {
  console.error("❌ SCRAPERAPI_KEY missing");
  process.exit(1);
}

// ================= YOUR PRODUCTS ARRAY =================
// Read product names from productlist.txt file
const productNames = fs.readFileSync("productlist.txt", "utf8")
  .split("\n")
  .map(line => line.trim())
  .filter(line => line && !line.startsWith("."))
  .slice(116); // Resume from product 117 (0-indexed)

const products = productNames.map(name => ({ name }));

// ================= UTIL =================

function saveAllResults(allProductsData) {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const filePath = path.join(OUTPUT_DIR, "all_products_images.json");
  fs.writeFileSync(filePath, JSON.stringify(allProductsData, null, 2));
  console.log(`💾 Saved all results → ${filePath}`);
}

// ================= SCRAPER =================

async function searchGoogleForAmazonLink(productName) {
  // Try direct Amazon search first (no Google)
  console.log("  🔍 Trying direct Amazon search...");
  const directLink = await tryDirectAmazonSearch(productName);
  if (directLink) {
    return directLink;
  }
  
  // If direct search fails, try Google
  console.log("  📱 Searching Google for Amazon link...");
  const query = `site:amazon.in "${productName}"`;
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

  const url = `https://api.scraperapi.com?api_key=${SCRAPER_API_KEY}` +
              `&url=${encodeURIComponent(googleUrl)}` +
              `&country_code=in` +
              `&device_type=desktop` +
              `&premium=true`;

  try {
    const response = await axios.get(url);
    const html = response.data;
    
    // Extract the first Amazon link from Google search results
    const amazonLink = extractFirstAmazonLink(html);
    
    return amazonLink;
    
  } catch (err) {
    console.error(`    ❌ Google search error: ${err.message}`);
    return null;
  }
}

async function tryDirectAmazonSearch(productName) {
  // Try direct Amazon search URL
  const searchQuery = productName.replace(/\s+/g, '+');
  const amazonSearchUrl = `https://www.amazon.in/s?k=${encodeURIComponent(searchQuery)}`;
  
  const scraperUrl = `https://api.scraperapi.com?api_key=${SCRAPER_API_KEY}` +
                      `&url=${encodeURIComponent(amazonSearchUrl)}` +
                      `&country_code=in` +
                      `&device_type=desktop`;
  
  try {
    const response = await axios.get(scraperUrl);
    const html = response.data;
    
    // Extract first product link from Amazon search results
    const productRegex = /href="\/dp\/([A-Z0-9]{10})"/g;
    const matches = [...html.matchAll(productRegex)];
    
    if (matches.length > 0) {
      const asin = matches[0][1];
      return `https://www.amazon.in/${asin}`;
    }
    
    return null;
  } catch (err) {
    return null;
  }
}

function extractFirstAmazonLink(html) {
  // Look for Google wrapped URLs that contain Amazon links
  const wrappedRegex = /\/url\?q=(https:\/\/www\.amazon\.in\/[^&]+)/g;
  const wrappedMatches = [...html.matchAll(wrappedRegex)];
  
  if (wrappedMatches.length > 0) {
    // Return the first Amazon URL as-is
    let amazonUrl = decodeURIComponent(wrappedMatches[0][1]);
    return amazonUrl;
  }
  
  // Fallback: Look for direct Amazon URLs
  const directRegex = /(https:\/\/www\.amazon\.in\/[^\s"]+)/g;
  const directMatches = [...html.matchAll(directRegex)];
  
  if (directMatches.length > 0) {
    return directMatches[0][1];
  }
  
  return null;
}

function extractAsinFromUrl(url) {
  const match = url.match(/\/dp\/([A-Z0-9]{10})|amazon\.in\/([A-Z0-9]{10})/);
  return match ? (match[1] || match[2]) : null;
}

async function getAmazonProductHtml(url) {
  const scraperUrl = `https://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(url)}`;
  
  const response = await axios.get(scraperUrl);
  return response.data;
}

function extractVariantAsins(html) {
  const match = html.match(/"variationValues"\s*:\s*({.*?})\s*,\s*"dimensionValuesDisplayData"/s);

  if (!match) return [];

  try {
    const cleaned = match[1]
      .replace(/\\u0026/g, "&")
      .replace(/'/g, '"');

    const parsed = JSON.parse(cleaned);

    if (!parsed.color_name) return [];

    return Object.values(parsed.color_name);

  } catch {
    return [];
  }
}

function extractColorName(html) {
  const match = html.match(/"color_name"\s*:\s*"([^"]+)"/);
  return match ? match[1] : "Unknown";
}

async function getAllColorVariantImages(baseAsin) {
  const baseUrl = `https://www.amazon.in/${baseAsin}`;
  
  try {
    const html = await getAmazonProductHtml(baseUrl);
    const variantAsins = extractVariantAsins(html);
    
    if (variantAsins.length === 0) {
      // No variants, just get images from base ASIN
      const colorName = extractColorName(html);
      const images = extractAllHighResImages(html);
      return { [colorName]: images };
    }
    
    const colorImages = {};
    
    for (const variantAsin of variantAsins) {
      try {
        const variantUrl = `https://www.amazon.in/${variantAsin}`;
        const variantHtml = await getAmazonProductHtml(variantUrl);
        const colorName = extractColorName(variantHtml);
        const images = extractAllHighResImages(variantHtml);
        
        colorImages[colorName] = images;
        console.log(`  🎨 ${colorName}: ${images.length} images`);
        
        // Rate limiting between variant requests
        await new Promise(r => setTimeout(r, 1000));
        
      } catch (err) {
        console.error(`    ❌ Error with variant ${variantAsin}: ${err.message}`);
      }
    }
    
    return colorImages;
    
  } catch (err) {
    console.error(`❌ Error getting variants for ${baseAsin}: ${err.message}`);
    return {};
  }
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
  
  const allProductsData = {
    total_products: products.length,
    scraped_at: new Date().toISOString(),
    products: []
  };
  
  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    console.log(`\n🔎 Processing product ${i + 1}/${products.length}: ${product.name}`);
    
    try {
      // Step 1: Search Google for Amazon link
      console.log("  📱 Searching Google for Amazon link...");
      const amazonLink = await searchGoogleForAmazonLink(product.name);
      
      if (!amazonLink) {
        console.log("  ⛔ No Amazon link found");
        allProductsData.products.push({
          name: product.name,
          status: "NO_LINK_FOUND",
          images: []
        });
      } else {
        console.log(`  ✅ Found Amazon link: ${amazonLink}`);
        
        // Step 2: Get images directly from the Amazon URL
        console.log("  🎨 Extracting images...");
        const html = await getAmazonProductHtml(amazonLink);
        const images = extractAllHighResImages(html);
        const colorName = extractColorName(html);
        
        console.log(`  ✅ Found ${images.length} images`);
        
        // Add to results
        allProductsData.products.push({
          name: product.name,
          status: "SUCCESS",
          amazon_link: amazonLink,
          color: colorName,
          image_count: images.length,
          images: images
        });
      }
      
      // Save progress after each product
      saveAllResults(allProductsData);
      
    } catch (err) {
      console.error(`❌ Error with ${product.name}: ${err.message}`);
      
      allProductsData.products.push({
        name: product.name,
        status: "ERROR",
        error: err.message,
        images: []
      });
      
      // Also save progress after errors
      saveAllResults(allProductsData);
    }
    
    // Rate limiting between products (important for Google)
    if (i < products.length - 1) {
      console.log("  ⏳ Waiting 10 seconds before next search...");
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  
  // Final save
  saveAllResults(allProductsData);
  
  // Summary
  const successCount = allProductsData.products.filter(p => p.status === "SUCCESS").length;
  const totalImages = allProductsData.products.reduce((sum, p) => sum + (p.image_count || 0), 0);
  
  console.log(`\n🎯 Done!`);
  console.log(`✅ Successfully scraped: ${successCount}/${products.length} products`);
  console.log(`📸 Total images collected: ${totalImages}`);
}

main();
