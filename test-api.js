// Test script for the GSM Arena Scraper API
import axios from 'axios';

const API_BASE_URL = 'http://localhost:3000';

// Test data
const testProductUrl = 'https://www.gsmarena.com/apple_iphone_15_pro_max-12650.php';

async function testAPI() {
  console.log('🧪 Testing GSM Arena Scraper API...\n');

  try {
    // Test health endpoint
    console.log('1. Testing health endpoint...');
    const healthResponse = await axios.get(`${API_BASE_URL}/health`);
    console.log('✅ Health check:', healthResponse.data);
    console.log();

    // Test single product scraping
    console.log('2. Testing single product scrape...');
    console.log(`URL: ${testProductUrl}`);
    
    const scrapeResponse = await axios.post(`${API_BASE_URL}/scrape`, {
      productUrl: testProductUrl
    });
    
    console.log('✅ Scrape response:', scrapeResponse.data);
    console.log();

    // Test bulk scraping
    console.log('3. Testing bulk scraping...');
    const bulkUrls = [
      'https://www.gsmarena.com/samsung_galaxy_s24_ultra-5989.php',
      'https://www.gsmarena.com/xiaomi_14_pro-12258.php'
    ];
    
    const bulkResponse = await axios.post(`${API_BASE_URL}/scrape-bulk`, {
      productUrls: bulkUrls
    });
    
    console.log('✅ Bulk scrape response:', bulkResponse.data);
    console.log();

    console.log('🎉 All tests completed successfully!');

  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
    
    if (error.code === 'ECONNREFUSED') {
      console.log('\n💡 Make sure the API server is running:');
      console.log('   npm run api');
    }
  }
}

// Run tests
testAPI();
