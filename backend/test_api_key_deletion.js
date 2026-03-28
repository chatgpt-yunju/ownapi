const axios = require('axios');
const BASE_URL = 'http://localhost:3000';

// Test API key deletion
async function testApiKeyDeletion() {
  try {
    // Step 1: Login as admin to get token
    console.log('Step 1: Logging in as admin...');
    const loginResp = await axios.post(`${BASE_URL}/api/auth/login`, {
      username: 'admin',
      password: 'admin123'
    });

    if (loginResp.data.step === 'email_verify') {
      console.log('⚠️  Login requires email verification');
      console.log('Masked email:', loginResp.data.masked_email);
      console.log('This is expected behavior - cannot test without email verification code');
      return;
    }

    const token = loginResp.data.token;
    console.log('✓ Login successful');

    // Step 2: Get all users to find one with API keys
    console.log('\nStep 2: Getting users with API keys...');
    const usersResp = await axios.get(`${BASE_URL}/api/plugins/ai-gateway/admin/users`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const usersWithKeys = usersResp.data.users.filter(u => u.key_count > 0);
    if (usersWithKeys.length === 0) {
      console.log('No users with API keys found');
      return;
    }

    const targetUser = usersWithKeys[0];
    console.log(`Found user: ${targetUser.username} (ID: ${targetUser.user_id}, Keys: ${targetUser.key_count})`);

    // Step 3: Get user's API keys
    console.log('\nStep 3: Getting user API keys...');
    const keysResp = await axios.get(`${BASE_URL}/api/plugins/ai-gateway/admin/users/${targetUser.user_id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log('User API keys:');
    keysResp.data.apiKeys.forEach(key => {
      console.log(`- ${key.key_display} (${key.name}) - Status: ${key.status}`);
    });

    // Step 4: Test admin deletion
    if (keysResp.data.apiKeys.length > 0) {
      const keyToDelete = keysResp.data.apiKeys[0].id;
      console.log(`\nStep 4: Testing admin deletion of key ${keyToDelete}...`);

      const deleteResp = await axios.delete(
        `${BASE_URL}/api/plugins/ai-gateway/admin/users/${targetUser.user_id}/api-keys/${keyToDelete}`,
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      console.log('Delete response:', deleteResp.data);

      // Step 5: Verify deletion
      console.log('\nStep 5: Verifying deletion...');
      const verifyResp = await axios.get(`${BASE_URL}/api/plugins/ai-gateway/admin/users/${targetUser.user_id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      console.log('\nAfter deletion - User API keys:');
      verifyResp.data.apiKeys.forEach(key => {
        console.log(`- ${key.key_display} (${key.name}) - Status: ${key.status}`);
      });

      // Check if key was marked as disabled
      const deletedKey = verifyResp.data.apiKeys.find(k => k.id === keyToDelete);
      if (deletedKey && deletedKey.status === 'disabled') {
        console.log('\n✅ SUCCESS: API key was successfully deleted (soft delete to disabled)');
      } else {
        console.log('\n❌ FAILURE: API key was not properly deleted');
      }
    }

  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    if (error.response?.status === 401) {
      console.log('\nNote: Authentication failed - email verification may be required');
    }
  }
}

testApiKeyDeletion();