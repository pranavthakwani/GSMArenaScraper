# GSMArena Incremental Scraper

A credit-efficient, dynamic scraping system for GSMArena that only scrapes newly launched products from 2023 or later using ScraperAPI.

## 🎯 Key Features

- **Incremental Scraping**: Only scrapes new products, never re-scrapes old ones
- **Credit Efficient**: Minimizes ScraperAPI usage with smart filtering
- **Block Detection**: Automatic kill switch when blocking/captcha is detected
- **Launch Year Filter**: Only stores products from 2023 or later
- **State Management**: Persistent tracking of scraped products
- **Automation Ready**: Safe to run daily via cron or scheduled jobs

## 📋 Requirements

- Node.js 16+
- ScraperAPI account and API key
- Environment variables setup

## 🚀 Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Set up environment variables**:
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` and add your ScraperAPI key:
   ```
   SCRAPERAPI_KEY=your_scraperapi_key_here
   ```

3. **Get ScraperAPI key**:
   - Sign up at [ScraperAPI.com](https://www.scraperapi.com/)
   - Copy your API key to the `.env` file

## 🏃‍♂️ Usage

### Run the scraper:
```bash
npm run scrape
```

### Or run directly:
```bash
node GSMArena-Refactored.js
```

## 📊 Output Files

- `seen_products.json`: Tracks all previously scraped product IDs
- `scraped_products.json`: Contains structured data for newly scraped products

### Product Data Structure
```json
{
  "id": "12771",
  "name": "Samsung Galaxy S23 Ultra",
  "brand": "Samsung",
  "category": "phone",
  "launchYear": 2023,
  "image": "https://...",
  "specs": {
    "Display": {
      "Type": "Dynamic AMOLED 2X",
      "Size": "6.8 inches"
    },
    "Battery": {
      "Type": "Li-Ion 5000 mAh"
    }
  },
  "scrapedAt": "2023-12-01T10:30:00.000Z"
}
```

## ⚙️ Configuration

Default settings (can be overridden in `.env`):

- `MIN_DELAY`: 3000ms (3 seconds minimum between requests)
- `MAX_DELAY`: 8000ms (8 seconds maximum between requests)
- `MIN_LAUNCH_YEAR`: 2023 (only scrape products from this year onward)
- `REQUEST_TIMEOUT`: 30000ms (30 seconds timeout)

## 🛡️ Safety Features

### Block Detection
The scraper automatically detects and stops on:
- Captcha pages
- Access denied messages
- Unusual traffic warnings
- Rate limiting
- Any blocking indicators

When blocking is detected:
- ❌ Immediate termination
- 🛑 No further credit consumption
- 💾 Saves all progress made
- 🔄 Safe to restart when block is lifted

### Credit Conservation
- **1 credit per request** through ScraperAPI
- **No parallel requests** to avoid rate limiting
- **Random delays** between 3-8 seconds
- **Smart filtering** skips already seen products
- **Early termination** on block detection

## 🔄 Incremental Scraping Logic

1. **Load State**: Reads `seen_products.json` for previously scraped products
2. **Detect Changes**: Scrapes brand listing pages to find new product IDs
3. **Filter New Products**: Only processes products not in seen_products
4. **Validate Launch Year**: Skips products older than 2023
5. **Scrape Details**: Fetches full product pages for new, valid products
6. **Update State**: Saves new products to seen_products.json
7. **Save Data**: Stores structured product data

## 📅 Automation

### Cron Job Example
```bash
# Run daily at 2 AM
0 2 * * * cd /path/to/project && npm run scrape
```

### GitHub Actions
```yaml
name: Daily GSMArena Scrape
on:
  schedule:
    - cron: '0 2 * * *'
jobs:
  scrape:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '16'
      - run: npm install
      - run: npm run scrape
        env:
          SCRAPERAPI_KEY: ${{ secrets.SCRAPERAPI_KEY }}
```

## 📈 Performance

### Credit Usage
- **Brand listing page**: 1 credit
- **Product detail page**: 1 credit
- **Total per new product**: 2 credits
- **Zero credits** for already seen products

### Example Costs
- 10 new products = 20 credits
- 0 new products = 2-25 credits (listing pages only)
- Blocked early = minimal credit loss

## 🚨 Troubleshooting

### "SCRAPERAPI_KEY environment variable is required"
- Set your API key in `.env` file
- Ensure `.env` is not ignored by git

### "BLOCK DETECTED - Emergency stop activated"
- Normal behavior when rate limited
- Wait 1-24 hours before retrying
- Consider increasing delays in configuration

### "Could not extract launch year"
- Product page structure may have changed
- Product may not have launch information
- Will be skipped automatically

## 🔄 Migration from Original Scraper

The refactored scraper is completely independent. To migrate:

1. Keep your original `GSMArena.js` for reference
2. Use `GSMArena-Refactored.js` for new scraping
3. The new scraper will build its own `seen_products.json` database
4. Old scraped data remains in separate files

## 📝 Development

### Code Structure
- **Configuration**: Constants and settings
- **State Management**: File-based persistence
- **Utility Functions**: Helpers and parsers
- **ScraperAPI Layer**: HTTP request handling
- **Parsing Layer**: HTML extraction logic
- **Incremental Logic**: Change detection and filtering
- **Main Function**: Orchestration and execution

### Adding New Brands
Edit the `BRANDS` array in `GSMArena-Refactored.js`:
```javascript
{ name: "brandname", url: "https://www.gsmarena.com/brandname-phones-123.php" }
```

## 📄 License

ISC License - see package.json for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

---

**⚠️ Important**: This scraper is designed for responsible, credit-efficient use. Always respect website terms of service and rate limits.
