package com.geo.common.llm.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * 统一聊天消息格式
 * 支持所有LLM平台的消息结构
 */
@Data
@Builder
@AllArgsConstructor
@NoArgsConstructor
public class ChatMessage {
    /**
     * 消息角色: "user", "assistant", "system"
     */
    private String role;

    /**
     * 消息内容
     */
    private String content;
}
