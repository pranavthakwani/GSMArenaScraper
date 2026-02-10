import fs from "fs";
import path from "path";

const PRODUCTS_DIR = "scraped_products";
const OUTPUT_FILE = "seen_products.json";

const seenProducts = {};

const files = fs.readdirSync(PRODUCTS_DIR);

for (const file of files) {
  if (!file.endsWith(".json")) continue;

  const filePath = path.join(PRODUCTS_DIR, file);
  const products = JSON.parse(fs.readFileSync(filePath, "utf8"));

  for (const product of products) {
    if (!product.id) continue;

    seenProducts[product.id] = {
      id: product.id,
      name: product.name,
      brand: product.brand,
      category: product.category,
      launchYear: product.launchYear,
      scrapedAt: product.scrapedAt
    };
  }
}

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(seenProducts, null, 2));

console.log(`✅ Rebuilt seen_products.json with ${Object.keys(seenProducts).length} products`);
