const axios = require('axios');

async function testAIMeeting() {
  try {
    console.log('1. 登录获取token...');
    const loginRes = await axios.post('http://localhost:3000/api/auth/login', {
      username: 'admin',
      password: 'admin123'
    });
    const token = loginRes.data.token;
    console.log('✓ 登录成功');

    console.log('\n2. 获取AI员工列表...');
    const employeesRes = await axios.get('http://localhost:3000/api/ai-employees', {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log(`✓ 获取到${employeesRes.data.length}个AI员工`);
    employeesRes.data.slice(0, 3).forEach(emp => {
      console.log(`  - ${emp.name} (${emp.category}, ${emp.model})`);
    });

    const selectedIds = employeesRes.data.slice(0, 3).map(e => e.id);
    console.log(`\n3. 召开会议，选择员工ID: ${selectedIds.join(', ')}`);
    
    const meetingRes = await axios.post('http://localhost:3000/api/ai-employees/meeting', {
      employeeIds: selectedIds,
      message: '请简单介绍一下你自己的专长',
      history: []
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log('\n✓ 会议响应:');
    meetingRes.data.responses.forEach(resp => {
      console.log(`\n【${resp.employeeName}】(${resp.model}):`);
      console.log(resp.content.substring(0, 100) + '...');
    });

    console.log('\n✅ 测试完成！');
  } catch (err) {
    console.error('❌ 测试失败:', err.response?.data || err.message);
  }
}

testAIMeeting();
