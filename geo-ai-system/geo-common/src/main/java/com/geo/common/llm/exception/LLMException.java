package com.geo.common.llm.exception;

import com.geo.common.llm.enums.LLMErrorCode;
import lombok.Getter;

/**
 * LLM异常
 */
@Getter
public class LLMException extends RuntimeException {
    /**
     * 错误码
     */
    private final LLMErrorCode code;

    /**
     * 错误信息
     */
    private final String errorMessage;

    public LLMException(LLMErrorCode code) {
        super(code.getMessage());
        this.code = code;
        this.errorMessage = code.getMessage();
    }

    public LLMException(LLMErrorCode code, String message) {
        super(message);
        this.code = code;
        this.errorMessage = message;
    }

    public LLMException(LLMErrorCode code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
        this.errorMessage = message;
    }

    public Integer getErrorCode() {
        return code.getCode();
    }
}
