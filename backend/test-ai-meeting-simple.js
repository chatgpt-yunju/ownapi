const http = require('http');

const postData = JSON.stringify({
  employeeIds: [1, 2],
  message: '请用一句话介绍你的专长',
  history: []
});

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/ai-employees/meeting',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer test_token',
    'Content-Length': Buffer.byteLength(postData)
  }
};

console.log('测试AI员工会议功能...\n');

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('响应状态:', res.statusCode);
    try {
      const result = JSON.parse(data);
      if (result.responses) {
        console.log('\n✓ 会议响应:');
        result.responses.forEach(resp => {
          console.log(`\n【${resp.employeeName}】(${resp.model}):`);
          console.log(resp.content.substring(0, 150));
        });
      } else {
        console.log('响应:', result);
      }
    } catch (e) {
      console.log('原始响应:', data);
    }
  });
});

req.on('error', (err) => {
  console.error('请求失败:', err.message);
});

req.write(postData);
req.end();
