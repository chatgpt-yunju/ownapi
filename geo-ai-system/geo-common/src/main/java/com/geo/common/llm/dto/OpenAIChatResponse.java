package com.geo.common.llm.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * OpenAI API响应格式
 */
@Data
@Builder
@AllArgsConstructor
@NoArgsConstructor
public class OpenAIChatResponse {
    /**
     * 响应ID
     */
    private String id;

    /**
     * 对象类型
     */
    private String object;

    /**
     * 创建时间戳
     */
    private Long created;

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
         * 选择索引
         */
        private Integer index;

        /**
         * 消息内容
         */
        private Message message;

        /**
         * 完成原因
         */
        private String finish_reason;
    }

    /**
     * 消息
     */
    @Data
    @Builder
    @AllArgsConstructor
    @NoArgsConstructor
    public static class Message {
        /**
         * 角色
         */
        private String role;

        /**
         * 内容
         */
        private String content;
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
