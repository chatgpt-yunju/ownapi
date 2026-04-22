package com.geo.system.llm;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.geo.common.llm.LLMBaseService;
import com.geo.common.llm.dto.ChatCompletionResult;
import com.geo.common.llm.dto.ChatMessage;
import com.geo.common.llm.dto.ModelInfo;
import com.geo.common.llm.dto.OpenAIChatRequest;
import com.geo.common.llm.dto.OpenAIChatResponse;
import com.geo.common.llm.enums.LLMErrorCode;
import com.geo.common.llm.exception.LLMException;
import com.geo.system.entity.TenantLlmConfig;
import com.geo.system.service.TenantLlmConfigService;
import lombok.extern.slf4j.Slf4j;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

import java.io.IOException;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

/**
 * OpenAI协议兼容的LLM服务实现
 * 支持所有遵循OpenAI API规范的LLM平台
 */
@Slf4j
@Service
public class OpenAICompatibleService implements LLMBaseService {

    @Autowired
    private TenantLlmConfigService tenantLlmConfigService;

    @Autowired
    private OkHttpClient okHttpClient;

    @Override
    public ChatCompletionResult chatCompletion(Long tenantId, List<ChatMessage> messages) throws LLMException {
        try {
            // 获取租户配置
            TenantLlmConfig config = tenantLlmConfigService.getTenantLlmConfig(tenantId);
            if (config == null || !config.getEnabled()) {
                throw new LLMException(LLMErrorCode.INVALID_CONFIG, "LLM配置不存在或未启用");
            }

            // 构建OpenAI格式请求
            OpenAIChatRequest request = OpenAIChatRequest.builder()
                    .model(config.getModelId())
                    .messages(messages)
                    .temperature(0.7)
                    .max_tokens(2000)
                    .stream(false)
                    .build();

            // 发起HTTP请求
            String requestBody = JSON.toJSONString(request);
            Request httpRequest = new Request.Builder()
                    .url(config.getBaseUrl() + "/v1/chat/completions")
                    .header("Authorization", "Bearer " + config.getApiKey())
                    .header("Content-Type", "application/json")
                    .post(RequestBody.create(requestBody, MediaType.parse("application/json")))
                    .build();

            // 执行请求
            Response response = okHttpClient.newCall(httpRequest).execute();
            if (!response.isSuccessful()) {
                String errorBody = response.body() != null ? response.body().string() : "";
                log.error("LLM API调用失败: tenantId={}, statusCode={}, body={}", tenantId, response.code(), errorBody);
                throw new LLMException(LLMErrorCode.API_ERROR, "LLM API调用失败: " + response.code());
            }

            // 解析响应
            String responseBody = response.body().string();
            OpenAIChatResponse openAIResponse = JSON.parseObject(responseBody, OpenAIChatResponse.class);

            // 转换为统一格式
            ChatCompletionResult result = convertToUnifiedFormat(openAIResponse);

            // 记录调用日志
            logLLMCall(tenantId, config, request, result);

            return result;
        } catch (LLMException e) {
            throw e;
        } catch (IOException e) {
            log.error("网络连接失败: tenantId={}", tenantId, e);
            throw new LLMException(LLMErrorCode.NETWORK_ERROR, "网络连接失败", e);
        } catch (Exception e) {
            log.error("未知错误: tenantId={}", tenantId, e);
            throw new LLMException(LLMErrorCode.UNKNOWN_ERROR, "未知错误", e);
        }
    }

    @Override
    public Flux<String> streamChatCompletion(Long tenantId, List<ChatMessage> messages) throws LLMException {
        return Flux.create(sink -> {
            try {
                // 获取租户配置
                TenantLlmConfig config = tenantLlmConfigService.getTenantLlmConfig(tenantId);
                if (config == null || !config.getEnabled()) {
                    sink.error(new LLMException(LLMErrorCode.INVALID_CONFIG, "LLM配置不存在或未启用"));
                    return;
                }

                // 构建OpenAI格式请求（启用流式）
                OpenAIChatRequest request = OpenAIChatRequest.builder()
                        .model(config.getModelId())
                        .messages(messages)
                        .temperature(0.7)
                        .max_tokens(2000)
                        .stream(true)
                        .build();

                // 发起HTTP请求
                String requestBody = JSON.toJSONString(request);
                Request httpRequest = new Request.Builder()
                        .url(config.getBaseUrl() + "/v1/chat/completions")
                        .header("Authorization", "Bearer " + config.getApiKey())
                        .header("Content-Type", "application/json")
                        .post(RequestBody.create(requestBody, MediaType.parse("application/json")))
                        .build();

                // 执行请求
                Response response = okHttpClient.newCall(httpRequest).execute();
                if (!response.isSuccessful()) {
                    sink.error(new LLMException(LLMErrorCode.API_ERROR, "LLM API调用失败: " + response.code()));
                    return;
                }

                // 处理流式响应
                if (response.body() != null) {
                    String line;
                    java.io.BufferedReader reader = new java.io.BufferedReader(response.body().charStream());
                    while ((line = reader.readLine()) != null) {
                        if (line.startsWith("data: ")) {
                            String data = line.substring(6);
                            if (!"[DONE]".equals(data)) {
                                sink.next(data);
                            }
                        }
                    }
                }

                sink.complete();
            } catch (Exception e) {
                log.error("流式调用失败: tenantId={}", tenantId, e);
                sink.error(e);
            }
        });
    }

    @Override
    public int countTokens(Long tenantId, String content) throws LLMException {
        try {
            // 简单估算：1 token ≈ 4字符
            return Math.max(1, content.length() / 4);
        } catch (Exception e) {
            log.error("Token计数失败: tenantId={}", tenantId, e);
            throw new LLMException(LLMErrorCode.UNKNOWN_ERROR, "Token计数失败", e);
        }
    }

    @Override
    public List<ModelInfo> listModels(Long tenantId) throws LLMException {
        try {
            // 返回常见模型列表
            List<ModelInfo> models = new ArrayList<>();
            models.add(ModelInfo.builder()
                    .id("gpt-4")
                    .name("GPT-4")
                    .description("OpenAI GPT-4 model")
                    .contextWindow(8192)
                    .costPer1kTokens(new BigDecimal("0.03"))
                    .build());
            models.add(ModelInfo.builder()
                    .id("gpt-3.5-turbo")
                    .name("GPT-3.5 Turbo")
                    .description("OpenAI GPT-3.5 Turbo model")
                    .contextWindow(4096)
                    .costPer1kTokens(new BigDecimal("0.0015"))
                    .build());
            models.add(ModelInfo.builder()
                    .id("claude-3-opus")
                    .name("Claude 3 Opus")
                    .description("Anthropic Claude 3 Opus model")
                    .contextWindow(200000)
                    .costPer1kTokens(new BigDecimal("0.015"))
                    .build());
            return models;
        } catch (Exception e) {
            log.error("获取模型列表失败: tenantId={}", tenantId, e);
            throw new LLMException(LLMErrorCode.UNKNOWN_ERROR, "获取模型列表失败", e);
        }
    }

    /**
     * 转换OpenAI响应为统一格式
     */
    private ChatCompletionResult convertToUnifiedFormat(OpenAIChatResponse openAIResponse) {
        List<ChatCompletionResult.Choice> choices = new ArrayList<>();
        if (openAIResponse.getChoices() != null) {
            for (OpenAIChatResponse.Choice choice : openAIResponse.getChoices()) {
                choices.add(ChatCompletionResult.Choice.builder()
                        .role(choice.getMessage().getRole())
                        .content(choice.getMessage().getContent())
                        .finish_reason(choice.getFinish_reason())
                        .build());
            }
        }

        ChatCompletionResult.Usage usage = null;
        if (openAIResponse.getUsage() != null) {
            usage = ChatCompletionResult.Usage.builder()
                    .prompt_tokens(openAIResponse.getUsage().getPrompt_tokens())
                    .completion_tokens(openAIResponse.getUsage().getCompletion_tokens())
                    .total_tokens(openAIResponse.getUsage().getTotal_tokens())
                    .build();
        }

        return ChatCompletionResult.builder()
                .id(openAIResponse.getId())
                .model(openAIResponse.getModel())
                .choices(choices)
                .usage(usage)
                .build();
    }

    /**
     * 记录LLM调用日志
     */
    private void logLLMCall(Long tenantId, TenantLlmConfig config, OpenAIChatRequest request, ChatCompletionResult result) {
        try {
            String apiKeyMasked = maskApiKey(config.getApiKey());
            log.info("LLM调用成功: tenantId={}, modelType={}, modelId={}, apiKey={}, tokens={}",
                    tenantId, config.getModelType(), config.getModelId(), apiKeyMasked,
                    result.getUsage() != null ? result.getUsage().getTotal_tokens() : 0);
        } catch (Exception e) {
            log.warn("记录LLM调用日志失败", e);
        }
    }

    /**
     * 掩码API密钥（仅显示前4和后4位）
     */
    private String maskApiKey(String apiKey) {
        if (apiKey == null || apiKey.length() < 8) {
            return "****";
        }
        return apiKey.substring(0, 4) + "****" + apiKey.substring(apiKey.length() - 4);
    }
}
