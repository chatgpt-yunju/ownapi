-- 添加 Google Gemini 系列模型，与官方 API 保持一致
-- 官方文档: https://ai.google.dev/gemini-api/docs/models/gemini

-- Gemini 3.1 Flash (最新快速模型)
INSERT INTO openclaw_models (
  model_id, display_name, provider,
  input_price_per_1k, output_price_per_1k, price_currency,
  status, sort_order
) VALUES (
  'gemini-3.1-flash', 'Gemini 3.1 Flash', 'google',
  0.00001875, 0.000075, 'USD',
  'active', 200
);

-- Gemini 3.1 Pro (最新高性能模型)
INSERT INTO openclaw_models (
  model_id, display_name, provider,
  input_price_per_1k, output_price_per_1k, price_currency,
  status, sort_order
) VALUES (
  'gemini-3.1-pro', 'Gemini 3.1 Pro', 'google',
  0.00125, 0.005, 'USD',
  'active', 201
);

-- Gemini 3.1 Flash-Lite (轻量级模型)
INSERT INTO openclaw_models (
  model_id, display_name, provider,
  input_price_per_1k, output_price_per_1k, price_currency,
  status, sort_order
) VALUES (
  'gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', 'google',
  0.00000375, 0.000015, 'USD',
  'active', 202
);

-- Gemini 2.0 Flash Exp (实验性免费模型)
INSERT INTO openclaw_models (
  model_id, display_name, provider,
  input_price_per_1k, output_price_per_1k, price_currency,
  status, sort_order
) VALUES (
  'gemini-2.0-flash-exp', 'Gemini 2.0 Flash (Experimental)', 'google',
  0.0, 0.0, 'USD',
  'active', 203
);

-- Gemini 1.5 Pro (稳定版高性能模型)
INSERT INTO openclaw_models (
  model_id, display_name, provider,
  input_price_per_1k, output_price_per_1k, price_currency,
  status, sort_order
) VALUES (
  'gemini-1.5-pro', 'Gemini 1.5 Pro', 'google',
  0.00125, 0.005, 'USD',
  'active', 204
);

-- Gemini 1.5 Flash (稳定版快速模型)
INSERT INTO openclaw_models (
  model_id, display_name, provider,
  input_price_per_1k, output_price_per_1k, price_currency,
  status, sort_order
) VALUES (
  'gemini-1.5-flash', 'Gemini 1.5 Flash', 'google',
  0.00001875, 0.000075, 'USD',
  'active', 205
);
