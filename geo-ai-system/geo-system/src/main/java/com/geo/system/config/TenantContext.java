package com.geo.system.config;

/**
 * 租户上下文管理工具类
 * 使用ThreadLocal存储当前请求的租户ID
 */
public class TenantContext {
    private static final ThreadLocal<Long> TENANT_ID = new ThreadLocal<>();

    /**
     * 设置当前租户ID
     */
    public static void setTenantId(Long tenantId) {
        TENANT_ID.set(tenantId);
    }

    /**
     * 获取当前租户ID
     */
    public static Long getTenantId() {
        return TENANT_ID.get();
    }

    /**
     * 清除租户ID（请求处理完成后调用）
     */
    public static void clear() {
        TENANT_ID.remove();
    }
}
