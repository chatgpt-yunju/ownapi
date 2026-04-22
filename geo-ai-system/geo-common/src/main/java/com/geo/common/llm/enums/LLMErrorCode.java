package com.geo.common.llm.enums;

import lombok.AllArgsConstructor;
import lombok.Getter;

/**
 * LLM错误码枚举
 */
@Getter
@AllArgsConstructor
public enum LLMErrorCode {
    /**
     * LLM配置无效
     */
    INVALID_CONFIG(4001, "LLM配置无效"),

    /**
     * LLM API调用失败
     */
    API_ERROR(4002, "LLM API调用失败"),

    /**
     * 请求过于频繁
     */
    RATE_LIMIT_EXCEEDED(4003, "请求过于频繁"),

    /**
     * Token额度不足
     */
    TOKEN_LIMIT_EXCEEDED(4004, "Token额度不足"),

    /**
     * 网络连接失败
     */
    NETWORK_ERROR(4005, "网络连接失败"),

    /**
     * 请求超时
     */
    TIMEOUT(4006, "请求超时"),

    /**
     * 未知错误
     */
    UNKNOWN_ERROR(5000, "未知错误");

    /**
     * 错误码
     */
    private final Integer code;

    /**
     * 错误信息
     */
    private final String message;
}
