package com.geo.common.exception;

import com.geo.common.constants.Constants;
import com.geo.common.model.ApiResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * Global exception handler for all controllers
 * Ensures all responses follow the unified {code, msg, data} format
 * No stack traces are exposed to clients
 */
@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    /**
     * Handle GeoException
     */
    @ExceptionHandler(GeoException.class)
    public ApiResponse<?> handleGeoException(GeoException e) {
        log.warn("GeoException: code={}, message={}", e.getCode(), e.getMessage());
        return ApiResponse.error(e.getCode(), e.getMessage());
    }

    /**
     * Handle validation errors
     */
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ApiResponse<?> handleMethodArgumentNotValidException(MethodArgumentNotValidException e) {
        String message = "参数验证失败: " + e.getBindingResult().getFieldError().getDefaultMessage();
        log.warn("Validation error: {}", message);
        return ApiResponse.error(Constants.BAD_REQUEST, message);
    }

    /**
     * Handle all other exceptions
     * Do NOT expose stack trace to client
     */
    @ExceptionHandler(Exception.class)
    public ApiResponse<?> handleException(Exception e) {
        log.error("Unexpected exception", e);
        return ApiResponse.error(Constants.SERVER_ERROR, Constants.SERVER_ERROR_MSG);
    }
}
