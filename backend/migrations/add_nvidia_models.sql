-- NVIDIA 模型配置
-- 使用前请先在 settings 表中添加 nvidia_api_key

-- 1. 添加 NVIDIA API Key 到 settings（请替换为你的实际 API Key）
INSERT INTO settings (`key`, `value`, description)
VALUES ('nvidia_api_key', 'nvapi-YOUR_API_KEY_HERE', 'NVIDIA API Key')
ON DUPLICATE KEY UPDATE `value` = 'nvapi-YOUR_API_KEY_HERE';

-- 2. 添加 NVIDIA 模型
INSERT INTO openclaw_models (
  model_id,
  display_name,
  provider,
  upstream_endpoint,
  input_price_per_1k,
  output_price_per_1k,
  status,
  sort_order
) VALUES
-- Llama 3.1 405B Instruct (最强大)
('meta/llama-3.1-405b-instruct', 'Llama 3.1 405B Instruct', 'nvidia',
 'https://integrate.api.nvidia.com/v1', 0.003600, 0.003600, 'active', 200),

-- Llama 3.1 70B Instruct (平衡性能)
('meta/llama-3.1-70b-instruct', 'Llama 3.1 70B Instruct', 'nvidia',
 'https://integrate.api.nvidia.com/v1', 0.000360, 0.000360, 'active', 201),

-- Llama 3.1 8B Instruct (快速便宜)
('meta/llama-3.1-8b-instruct', 'Llama 3.1 8B Instruct', 'nvidia',
 'https://integrate.api.nvidia.com/v1', 0.000144, 0.000144, 'active', 202),

-- Mistral Large 2 (高性能)
('mistralai/mistral-large-2-instruct', 'Mistral Large 2', 'nvidia',
 'https://integrate.api.nvidia.com/v1', 0.002160, 0.002160, 'active', 203),

-- Mixtral 8x7B (MoE 架构)
('mistralai/mixtral-8x7b-instruct-v0.1', 'Mixtral 8x7B', 'nvidia',
 'https://integrate.api.nvidia.com/v1', 0.000360, 0.000360, 'active', 204)

ON DUPLICATE KEY UPDATE
  display_name = VALUES(display_name),
  upstream_endpoint = VALUES(upstream_endpoint),
  input_price_per_1k = VALUES(input_price_per_1k),
  output_price_per_1k = VALUES(output_price_per_1k);
