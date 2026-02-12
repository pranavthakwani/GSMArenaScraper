import fs from 'fs';
import path from 'path';
import sql from 'mssql';
import dotenv from 'dotenv';

dotenv.config();

const config = {
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

async function uploadJsonFile(filePath, pool) {
  try {
    console.log(`Processing file: ${path.basename(filePath)}`);
    
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    
    if (!Array.isArray(data)) {
      console.log(`Skipping ${path.basename(filePath)} - not an array`);
      return { success: false, error: 'Not an array' };
    }

    const jsonString = JSON.stringify(data);

    await pool.request()
      .input('json', sql.NVarChar(sql.MAX), jsonString)
      .execute('SP_WT_SCM_ItemsSpecs_Insert');

    console.log(`Completed ${path.basename(filePath)}: ${data.length} uploaded`);
    return { success: true, successCount: data.length, errorCount: 0 };

  } catch (error) {
    console.error(`Error processing file ${filePath}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function uploadAllJsonFiles() {
  const scrapedProductsDir = path.join(process.cwd(), 'scraped_products');
  
  try {
    console.log('Connecting to SQL Server...');
    const pool = await sql.connect(config);
    console.log('Connected successfully!');
    
    const files = fs.readdirSync(scrapedProductsDir)
      .filter(file => file.endsWith('.json'))
      .map(file => path.join(scrapedProductsDir, file));
    
    console.log(`Found ${files.length} JSON files to process`);
    
    let totalSuccess = 0;
    let totalErrors = 0;
    
    for (const filePath of files) {
      const result = await uploadJsonFile(filePath, pool);
      if (result.success) {
        totalSuccess += result.successCount || 0;
        totalErrors += result.errorCount || 0;
      }
    }
    
    console.log('\n=== Upload Summary ===');
    console.log(`Total items uploaded: ${totalSuccess}`);
    console.log(`Total errors: ${totalErrors}`);
    console.log('====================');
    
    await pool.close();
    
  } catch (error) {
    console.error('Connection error:', error.message);
    process.exit(1);
  }
}

console.log('Script loaded, checking execution context...');

// Fix Windows path comparison
const currentFile = import.meta.url;
const scriptPath = process.argv[1];
const normalizedScriptPath = `file:///${scriptPath.replace(/\\/g, '/').replace(/ /g, '%20')}`;

if (currentFile === normalizedScriptPath) {
  console.log('Starting upload process...');
  uploadAllJsonFiles().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
} else {
  console.log('Script imported as module, not executing directly');
  console.log('import.meta.url:', currentFile);
  console.log('process.argv[1]:', scriptPath);
  console.log('normalized script path:', normalizedScriptPath);
}

export { uploadAllJsonFiles };
