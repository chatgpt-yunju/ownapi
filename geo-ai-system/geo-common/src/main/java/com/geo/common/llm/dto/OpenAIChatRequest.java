package com.geo.common.llm.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * OpenAI兼容的聊天请求格式
 */
@Data
@Builder
@AllArgsConstructor
@NoArgsConstructor
public class OpenAIChatRequest {
    /**
     * 模型ID
     */
    private String model;

    /**
     * 消息列表
     */
    private List<ChatMessage> messages;

    /**
     * 温度参数，控制随机性 (0-2)
     */
    @Builder.Default
    private Double temperature = 0.7;

    /**
     * 最大生成Token数
     */
    @Builder.Default
    private Integer max_tokens = 2000;

    /**
     * Top-p采样参数
     */
    @Builder.Default
    private Double top_p = 1.0;

    /**
     * 是否流式输出
     */
    @Builder.Default
    private Boolean stream = false;
}
