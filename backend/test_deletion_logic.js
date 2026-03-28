const mysql = require('mysql2/promise');
const db = require('./src/config/db');

async function testDeletionLogic() {
  console.log('Testing API key deletion logic...\n');

  const connection = await db.getConnection();

  try {
    // Step 1: Find an active API key to delete
    const [activeKeys] = await connection.execute(
      'SELECT id, key_display, name, status, user_id FROM openclaw_api_keys WHERE status = "active" LIMIT 3'
    );

    if (activeKeys.length === 0) {
      console.log('No active API keys found');
      return;
    }

    const testKey = activeKeys[0];
    console.log(`Testing with key: ${testKey.key_display} (ID: ${testKey.id}, User: ${testKey.user_id})`);

    // Step 2: Simulate the admin deletion logic
    console.log('\nStep 2: Simulating admin deletion...');

    const [deleteResult] = await connection.execute(
      'UPDATE openclaw_api_keys SET status = "disabled" WHERE id = ? AND user_id = ?',
      [testKey.id, testKey.user_id]
    );

    console.log(`Update result: ${deleteResult.affectedRows} row(s) affected`);

    if (deleteResult.affectedRows > 0) {
      // Step 3: Verify the key was marked as disabled
      const [updatedKey] = await connection.execute(
        'SELECT id, key_display, name, status FROM openclaw_api_keys WHERE id = ?',
        [testKey.id]
      );

      console.log('\nAfter deletion:');
      console.log(`- ID: ${updatedKey[0].id}`);
      console.log(`- Display: ${updatedKey[0].key_display}`);
      console.log(`- Status: ${updatedKey[0].status}`);

      if (updatedKey[0].status === 'disabled') {
        console.log('\n✅ SUCCESS: Key was successfully deleted (soft delete)');

        // Step 4: Test the reverse (re-enabling)
        console.log('\nStep 4: Testing re-enabling...');
        await connection.execute(
          'UPDATE openclaw_api_keys SET status = "active" WHERE id = ?',
          [testKey.id]
        );

        const [reenabledKey] = await connection.execute(
          'SELECT status FROM openclaw_api_keys WHERE id = ?',
          [testKey.id]
        );

        if (reenabledKey[0].status === 'active') {
          console.log('✅ SUCCESS: Key was successfully re-enabled');
        } else {
          console.log('❌ FAILURE: Key was not re-enabled');
        }
      } else {
        console.log('\n❌ FAILURE: Key status was not updated');
      }
    } else {
      console.log('\n❌ FAILURE: No rows were affected - key not found or user mismatch');
    }

    // Step 5: Demonstrate the permission check
    console.log('\nStep 5: Testing permission logic...');

    // Try to delete a key that doesn't belong to the user
    const [wrongUserResult] = await connection.execute(
      'UPDATE openclaw_api_keys SET status = "disabled" WHERE id = ? AND user_id = ?',
      [testKey.id, 99999] // Non-existent user ID
    );

    console.log(`Wrong user delete attempt: ${wrongUserResult.affectedRows} row(s) affected`);
    if (wrongUserResult.affectedRows === 0) {
      console.log('✅ SUCCESS: Permission check working - no rows affected for wrong user');
    }

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    connection.release();
  }
}

testDeletionLogic().catch(console.error);