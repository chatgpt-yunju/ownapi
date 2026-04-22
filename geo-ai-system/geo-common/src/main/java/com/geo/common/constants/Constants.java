package com.geo.common.constants;

/**
 * Global constants for the GEO system
 */
public class Constants {
    // HTTP Status Codes
    public static final int SUCCESS = 200;
    public static final int BAD_REQUEST = 400;
    public static final int UNAUTHORIZED = 401;
    public static final int FORBIDDEN = 403;
    public static final int NOT_FOUND = 404;
    public static final int TOO_MANY_REQUESTS = 429;
    public static final int SERVER_ERROR = 500;

    // Error Messages
    public static final String SUCCESS_MSG = "操作成功";
    public static final String BAD_REQUEST_MSG = "参数错误";
    public static final String UNAUTHORIZED_MSG = "未登录或Token过期";
    public static final String FORBIDDEN_MSG = "权限不足";
    public static final String NOT_FOUND_MSG = "资源不存在";
    public static final String TOO_MANY_REQUESTS_MSG = "请求过于频繁";
    public static final String SERVER_ERROR_MSG = "服务端异常";

    // Tenant Context
    public static final String TENANT_ID_HEADER = "X-Tenant-Id";
    public static final String AUTHORIZATION_HEADER = "Authorization";
    public static final String BEARER_PREFIX = "Bearer ";

    // JWT
    public static final String JWT_CLAIMS_TENANT_ID = "tenantId";
    public static final String JWT_CLAIMS_USER_ID = "userId";
    public static final String JWT_CLAIMS_ROLES = "roles";
}
