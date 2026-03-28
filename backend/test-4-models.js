require('dotenv').config();
const { rewriteContent } = require('./src/services/aiRewrite');

const testContent = `人工智能技术正在快速发展，深度学习算法在图像识别、自然语言处理等领域取得了突破性进展。越来越多的企业开始将AI技术应用到实际业务中，提升效率和用户体验。`;

async function testAllModels() {
  const models = ['kimi', 'deepseek', 'glm', 'qwen'];

  console.log('='.repeat(80));
  console.log('测试内容：', testContent);
  console.log('='.repeat(80));
  console.log('');

  for (const model of models) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`测试模型: ${model.toUpperCase()}`);
    console.log('='.repeat(80));

    try {
      const startTime = Date.now();
      const result = await rewriteContent(testContent, model);
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      console.log(`✅ 成功 (耗时: ${duration}秒)`);
      console.log(`使用的模型: ${result.model}`);
      console.log(`\n改写结果:\n${result.content}`);
    } catch (error) {
      console.log(`❌ 失败: ${error.message}`);
    }
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log('测试完成');
  console.log('='.repeat(80));
}

testAllModels().catch(console.error);
