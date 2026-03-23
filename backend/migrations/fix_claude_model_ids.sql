-- 修复 Claude 模型 ID，与官方 Anthropic API 保持一致
-- anthropic/claude-opus-4-6 → claude-opus-4-6
-- ccclub/claude-haiku-4-5   → claude-haiku-4-5-20251001

UPDATE openclaw_models
SET model_id = 'claude-opus-4-6'
WHERE model_id IN ('anthropic/claude-opus-4-6', 'ccclub/claude-opus-4-6');

UPDATE openclaw_models
SET model_id = 'claude-haiku-4-5-20251001'
WHERE model_id IN ('ccclub/claude-haiku-4-5', 'claude-haiku-4-5');

-- upstream_model_id 也需要是官方格式（CC Club 接受标准 Anthropic model ID）
UPDATE openclaw_models
SET upstream_model_id = NULL
WHERE model_id IN ('claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001')
  AND upstream_model_id IN ('anthropic/claude-opus-4-6', 'ccclub/claude-opus-4-6', 'ccclub/claude-haiku-4-5');

-- 确认所有 Claude 模型的 provider 字段正确
UPDATE openclaw_models
SET provider = 'ccclub'
WHERE model_id IN ('claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001')
  AND provider IN ('', 'anthropic', NULL);
