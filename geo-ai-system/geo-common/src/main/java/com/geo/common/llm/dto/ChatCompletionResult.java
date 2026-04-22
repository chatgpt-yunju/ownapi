package com.geo.common.llm.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * 统一聊天完成结果格式
 * 对应OpenAI API响应格式
 */
@Data
@Builder
@AllArgsConstructor
@NoArgsConstructor
public class ChatCompletionResult {
    /**
     * 响应ID
     */
    private String id;

    /**
     * 使用的模型
     */
    private String model;

    /**
     * 选择列表
     */
    private List<Choice> choices;

    /**
     * Token使用统计
     */
    private Usage usage;

    /**
     * 选择项
     */
    @Data
    @Builder
    @AllArgsConstructor
    @NoArgsConstructor
    public static class Choice {
        /**
         * 消息角色
         */
        private String role;

        /**
         * 消息内容
         */
        private String content;

        /**
         * 完成原因: "stop", "length", "content_filter"
         */
        private String finish_reason;
    }

    /**
     * Token使用统计
     */
    @Data
    @Builder
    @AllArgsConstructor
    @NoArgsConstructor
    public static class Usage {
        /**
         * 提示词Token数
         */
        private Integer prompt_tokens;

        /**
         * 完成Token数
         */
        private Integer completion_tokens;

        /**
         * 总Token数
         */
        private Integer total_tokens;
    }
}
