package com.geo.common.llm;

import com.geo.common.llm.dto.ChatCompletionResult;
import com.geo.common.llm.dto.ChatMessage;
import com.geo.common.llm.dto.ModelInfo;
import com.geo.common.llm.exception.LLMException;
import reactor.core.publisher.Flux;

import java.util.List;

/**
 * LLM统一服务接口
 * 定义所有LLM平台实现的统一契约
 */
public interface LLMBaseService {

    /**
     * 同步聊天完成
     *
     * @param tenantId 租户ID
     * @param messages 消息列表
     * @return 聊天完成结果
     * @throws LLMException LLM异常
     */
    ChatCompletionResult chatCompletion(Long tenantId, List<ChatMessage> messages) throws LLMException;

    /**
     * 流式聊天完成（Server-Sent Events）
     *
     * @param tenantId 租户ID
     * @param messages 消息列表
     * @return 流式响应，每个元素为一个SSE事件
     * @throws LLMException LLM异常
     */
    Flux<String> streamChatCompletion(Long tenantId, List<ChatMessage> messages) throws LLMException;

    /**
     * 计算内容的Token数
     *
     * @param tenantId 租户ID
     * @param content 内容
     * @return Token数
     * @throws LLMException LLM异常
     */
    int countTokens(Long tenantId, String content) throws LLMException;

    /**
     * 获取租户可用的模型列表
     *
     * @param tenantId 租户ID
     * @return 模型信息列表
     * @throws LLMException LLM异常
     */
    List<ModelInfo> listModels(Long tenantId) throws LLMException;
}
