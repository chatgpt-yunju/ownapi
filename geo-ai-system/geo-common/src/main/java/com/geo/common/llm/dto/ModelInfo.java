package com.geo.common.llm.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.math.BigDecimal;

/**
 * 模型信息
 */
@Data
@Builder
@AllArgsConstructor
@NoArgsConstructor
public class ModelInfo {
    /**
     * 模型ID
     */
    private String id;

    /**
     * 模型名称
     */
    private String name;

    /**
     * 模型描述
     */
    private String description;

    /**
     * 上下文窗口大小
     */
    private Integer contextWindow;

    /**
     * 每1000个Token的成本
     */
    private BigDecimal costPer1kTokens;
}
