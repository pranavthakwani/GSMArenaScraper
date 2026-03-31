import fs from "fs";

// Read product list
const productLines = fs.readFileSync("productlist.txt", "utf8")
  .split("\n")
  .map(line => line.trim())
  .filter(line => line && !line.startsWith("."));

// Remove duplicates and create comma-separated string
const uniqueProducts = [...new Set(productLines)];
const productNames = uniqueProducts.join(",");

console.log(`Found ${uniqueProducts.length} unique products`);
console.log("\nAdd this to your .env file:");
console.log(`PRODUCT_NAMES=${productNames}`);

// Also create the .env content
const envContent = `# ScraperAPI Key - Get from https://www.scraperapi.com/
SCRAPERAPI_KEY=your_scraperapi_key_here

# Product Names - Add comma-separated product names to search on Amazon
# The scraper will Google search each name and find the Amazon product link
PRODUCT_NAMES=${productNames}`;

fs.writeFileSync(".env", envContent);
console.log("\n✅ Created .env file with your products");
console.log("📝 Don't forget to add your actual SCRAPERAPI_KEY");
