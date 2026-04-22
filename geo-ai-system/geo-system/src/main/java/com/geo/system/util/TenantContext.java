package com.geo.system.util;

/**
 * Tenant Context Utility
 * Stores and retrieves the current tenant ID using ThreadLocal
 */
public class TenantContext {
    private static final ThreadLocal<Long> tenantIdHolder = new ThreadLocal<>();

    /**
     * Set the current tenant ID
     */
    public static void setTenantId(Long tenantId) {
        tenantIdHolder.set(tenantId);
    }

    /**
     * Get the current tenant ID
     */
    public static Long getTenantId() {
        return tenantIdHolder.get();
    }

    /**
     * Clear the tenant ID
     */
    public static void clear() {
        tenantIdHolder.remove();
    }
}
