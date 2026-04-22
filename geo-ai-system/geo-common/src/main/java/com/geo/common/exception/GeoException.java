package com.geo.common.exception;

/**
 * Custom exception for GEO system
 * Includes error code for API response
 */
public class GeoException extends RuntimeException {
    private int code;

    public GeoException(int code, String message) {
        super(message);
        this.code = code;
    }

    public GeoException(String message) {
        super(message);
        this.code = 500;
    }

    public GeoException(int code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }

    public int getCode() {
        return code;
    }

    public void setCode(int code) {
        this.code = code;
    }
}
