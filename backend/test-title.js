require('dotenv').config();
const { generateTitle } = require('./src/services/aiRewrite');

const testContent = `人工智能技术正在快速发展，深度学习模型的能力越来越强大。从图像识别到自然语言处理，AI已经在各个领域展现出惊人的潜力。未来，AI将继续改变我们的生活方式和工作方式。

---
*由DeepSeek提供技术支持*`;

generateTitle(testContent)
  .then(title => {
    console.log('生成的标题:', title);
    console.log('标题长度:', title.length);
  })
  .catch(err => {
    console.error('错误:', err.message);
  });
