const axios = require('axios');
const mysql = require('mysql2/promise');

const BASE_URL = 'http://localhost:3000';

async function testAIEmployees() {
  console.log('=== AI员工功能测试 ===\n');

  // 1. 测试获取员工列表
  console.log('1. 测试GET /api/ai-employees');
  try {
    const res = await axios.get(`${BASE_URL}/api/ai-employees`);
    console.log(`✓ 获取到 ${res.data.length} 个员工`);
    const firstEmployee = res.data[0];
    console.log(`  示例: ${firstEmployee.name} (creator_id=${firstEmployee.creator_id}, is_editable=${firstEmployee.is_editable})`);
  } catch (err) {
    console.log(`✗ 失败: ${err.message}`);
  }

  // 2. 测试创建员工（需要登录）
  console.log('\n2. 测试POST /api/ai-employees (需要登录)');
  console.log('  跳过 - 需要有效token');

  // 3. 测试智能匹配（需要登录）
  console.log('\n3. 测试POST /api/ai-employees/smart-match (需要登录)');
  console.log('  跳过 - 需要有效token');

  // 4. 检查数据库字段
  console.log('\n4. 检查数据库字段');
  try {
    const db = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: '',
      database: 'wechat_cms'
    });

    const [fields] = await db.query("DESC ai_employees");
    const hasCreatorId = fields.some(f => f.Field === 'creator_id');
    const hasIsEditable = fields.some(f => f.Field === 'is_editable');

    console.log(`  creator_id字段: ${hasCreatorId ? '✓ 存在' : '✗ 不存在'}`);
    console.log(`  is_editable字段: ${hasIsEditable ? '✓ 存在' : '✗ 不存在'}`);

    const [employees] = await db.query('SELECT COUNT(*) as total, SUM(creator_id IS NULL) as system_count FROM ai_employees');
    console.log(`  总员工数: ${employees[0].total}, 系统员工: ${employees[0].system_count}`);

    await db.end();
  } catch (err) {
    console.log(`✗ 数据库检查失败: ${err.message}`);
  }

  console.log('\n=== 测试完成 ===');
}

testAIEmployees();
