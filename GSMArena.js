import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";

const BASE = "https://www.gsmarena.com";
const DELAY = 3000; // 3 sec per request (SAFE)
const BRAND_CONCURRENCY = 2; // DO NOT increase blindly

const sleep = () => new Promise(r => setTimeout(r, DELAY));

/* =========================
   BRANDS (MOSTLY ALL)
   ========================= */

const BRANDS = [
  // Top brands
  { name: "samsung", url: "https://www.gsmarena.com/samsung-phones-9.php" },
  { name: "apple", url: "https://www.gsmarena.com/apple-phones-48.php" },
  { name: "xiaomi", url: "https://www.gsmarena.com/xiaomi-phones-80.php" },
  { name: "oppo", url: "https://www.gsmarena.com/oppo-phones-82.php" },
  { name: "vivo", url: "https://www.gsmarena.com/vivo-phones-98.php" },
  { name: "google", url: "https://www.gsmarena.com/google-phones-107.php" },
  { name: "infinix", url: "https://www.gsmarena.com/infinix-phones-119.php" },
  { name: "tecno", url: "https://www.gsmarena.com/tecno-phones-120.php" },
  { name: "itel", url: "https://www.gsmarena.com/itel-phones-131.php" },
  { name: "nothing", url: "https://www.gsmarena.com/nothing-phones-128.php" },
  { name: "motorola", url: "https://www.gsmarena.com/motorola-phones-4.php" },
  { name: "lenovo", url: "https://www.gsmarena.com/lenovo-phones-73.php" },
  { name: "realme", url: "https://www.gsmarena.com/realme-phones-118.php" },
  { name: "oneplus", url: "https://www.gsmarena.com/oneplus-phones-95.php" },
  { name: "asus", url: "https://www.gsmarena.com/asus-phones-46.php" },
  { name: "micromax", url: "https://www.gsmarena.com/micromax-phones-66.php" },
  { name: "huawei", url: "https://www.gsmarena.com/huawei-phones-58.php" },
  { name: "honor", url: "https://www.gsmarena.com/honor-phones-121.php" },
  { name: "nokia", url: "https://www.gsmarena.com/nokia-phones-1.php" },
  { name: "sony", url: "https://www.gsmarena.com/sony-phones-7.php" },
  { name: "lg", url: "https://www.gsmarena.com/lg-phones-20.php" },
  { name: "tcl", url: "https://www.gsmarena.com/tcl-phones-123.php" },
  { name: "htc", url: "https://www.gsmarena.com/htc-phones-45.php" },
  { name: "zte", url: "https://www.gsmarena.com/zte-phones-62.php" },
  { name: "alcatel", url: "https://www.gsmarena.com/alcatel-phones-5.php" },
 { name: "sharp", url: "https://www.gsmarena.com/sharp-phones-23.php" },
//   { name: "ulefone", url: "https://www.gsmarena.com/ulefone-phones-124.php" },
//   { name: "doogee", url: "https://www.gsmarena.com/doogee-phones-129.php" },
//   { name: "blackview", url: "https://www.gsmarena.com/blackview-phones-116.php" },
//   { name: "cubot", url: "https://www.gsmarena.com/cubot-phones-130.php" },
//   { name: "oukitel", url: "https://www.gsmarena.com/oukitel-phones-132.php" },
//   { name: "umidigi", url: "https://www.gsmarena.com/umidigi-phones-135.php" },
//   { name: "coolpad", url: "https://www.gsmarena.com/coolpad-phones-105.php" },
//   { name: "meizu", url: "https://www.gsmarena.com/meizu-phones-74.php" },
//   { name: "oscal", url: "https://www.gsmarena.com/oscal-phones-134.php" }
];

/* =========================
   STEP 1: BRAND PAGE LINKS
   ========================= */

async function getBrandPageLinks(url) {
  const { data } = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    validateStatus: s => s === 200
  });

  const $ = cheerio.load(data);
  const links = [];

  $(".makers li a").each((_, el) => {
    const href = $(el).attr("href");
    if (href?.endsWith(".php")) {
      links.push(`${BASE}/${href}`);
    }
  });

  return links;
}

/* =========================
   STEP 2: PAGINATION
   ========================= */

async function getAllBrandProducts(brandUrl) {
  const match = brandUrl.match(/\/([a-z0-9-]+)-phones-(\d+)\.php/i);
  if (!match) throw new Error("Invalid brand URL");

  const slug = match[1];
  const id = match[2];

  let page = 1;
  let allLinks = [];

  while (true) {
    const url =
      page === 1
        ? `${BASE}/${slug}-phones-${id}.php`
        : `${BASE}/${slug}-phones-f-${id}-0-p${page}.php`;

    console.log("Fetching:", url);

    const links = await getBrandPageLinks(url);
    if (!links.length) break;

    allLinks.push(...links);
    page++;
    await sleep();
  }

  return [...new Set(allLinks)];
}

/* =========================
   STEP 3: PRODUCT SCRAPER
   ========================= */

async function scrapeProduct(url) {
  const { data } = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    validateStatus: s => s === 200
  });

  const $ = cheerio.load(data);

  const name = $("h1").text().trim();
  const image = $(".specs-photo-main img").attr("src") || null;

  const specs = {};
  $("#specs-list table").each((_, table) => {
    const section = $(table).find("th").first().text().trim();
    $(table).find("tr").each((_, row) => {
      const key = $(row).find(".ttl").text().trim();
      const val = $(row).find(".nfo").text().trim();
      if (key && val) specs[`${section}.${key}`] = val;
    });
  });

  return {
    id: url.split("/").pop().replace(".php", ""),
    brand: name.split(" ")[0],
    name,
    image,
    specs
  };
}

/* =========================
   STEP 4: SCRAPE BRAND
   ========================= */

async function scrapeBrand(brand) {
  console.log(`\n=== START ${brand.name.toUpperCase()} ===`);
  const productLinks = await getAllBrandProducts(brand.url);
  console.log(`Found ${productLinks.length} products`);

  const results = [];
  for (const link of productLinks) {
    try {
      const product = await scrapeProduct(link);
      results.push(product);
      console.log("Scraped:", product.name);
      await sleep();
    } catch {
      console.log("Failed:", link);
    }
  }

  // Create directory if it doesn't exist
  const outputDir = "All Brands Scraped Data";
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, `${brand.name}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`=== DONE ${brand.name.toUpperCase()} ===`);
}

/* =========================
   RUN ALL BRANDS
   ========================= */

for (const brand of BRANDS) {
  await scrapeBrand(brand);
}

console.log("\n✅ ALL BRANDS SCRAPED");