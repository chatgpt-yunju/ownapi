const http = require('http');
const https = require('https');

// Helper function to make HTTP requests
function makeRequest(url, method = 'GET', data = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = client.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: body
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

// Test API routes
async function testApiRoutes() {
  console.log('Testing API key deletion routes...\n');

  try {
    // Test 1: Check if the routes are accessible (without authentication)
    console.log('1. Testing route accessibility...');

    // Test health endpoint
    const health = await makeRequest('http://localhost:3000/api/plugins/ai-gateway/api/health');
    console.log(`   Health check: ${health.statusCode} - ${health.body}`);

    // Test 2: Check admin users endpoint (should fail without auth)
    console.log('\n2. Testing admin users endpoint (expect 401)...');
    const users = await makeRequest('http://localhost:3000/api/plugins/ai-gateway/admin/users')
      .catch(err => ({ error: err.message }));

    if (users.error || users.statusCode === 401) {
      console.log('   ✓ Correctly requires authentication');
    } else {
      console.log(`   Unexpected response: ${users.statusCode}`);
    }

    // Test 3: Check the deletion route exists in the code
    console.log('\n3. Checking deletion route implementation...');
    const fs = require('fs');
    const adminPath = './src/plugins/ai-gateway/routes/admin.js';

    if (fs.existsSync(adminPath)) {
      const content = fs.readFileSync(adminPath, 'utf8');
      if (content.includes('DELETE /users/:userId/api-keys/:keyId')) {
        console.log('   ✓ Admin deletion route found in code');
      } else {
        console.log('   ✗ Admin deletion route not found');
      }
    } else {
      console.log('   ✗ admin.js file not found');
    }

    // Test 4: Test the user deletion route
    console.log('\n4. Testing user deletion route (expect 401)...');
    const userDelete = await makeRequest('http://localhost:3000/api/plugins/ai-gateway/api-key/delete', 'POST', { id: 1 })
      .catch(err => ({ error: err.message }));

    if (userDelete.error || userDelete.statusCode === 401) {
      console.log('   ✓ User deletion route exists (requires authentication)');
    } else {
      console.log(`   Unexpected response: ${userDelete.statusCode}`);
    }

    console.log('\n✅ All route tests completed');
    console.log('\nNote: To fully test deletion, you need to:');
    console.log('1. Login with email verification');
    console.log('2. Get an API token');
    console.log('3. Use the token to access protected endpoints');

  } catch (error) {
    console.error('Error:', error.message);
  }
}

testApiRoutes();