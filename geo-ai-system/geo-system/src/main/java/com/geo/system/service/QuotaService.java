package com.geo.system.service;

import com.geo.system.dto.QuotaUsageDTO;

/**
 * 配额管理Service接口
 * 支持月度诊断次数、监控个数、创作次数三种配额
 */
public interface QuotaService {

    /**
     * 检查配额是否充足
     * @param tenantId 租户ID
     * @param quotaType 配额类型 (diagnosis/monitor/content)
     * @return true表示配额充足，false表示配额不足
     */
    boolean checkQuota(Long tenantId, String quotaType);

    /**
     * 消耗配额
     * @param tenantId 租户ID
     * @param quotaType 配额类型 (diagnosis/monitor/content)
     * @param count 消耗数量
     * @throws com.geo.common.exception.GeoException 配额不足时抛出异常
     */
    void consumeQuota(Long tenantId, String quotaType, int count);

    /**
     * 获取当前配额使用情况
     * @param tenantId 租户ID
     * @return QuotaUsageDTO 包含三种配额的使用情况
     */
    QuotaUsageDTO getQuotaUsage(Long tenantId);

    /**
     * 重置单个租户配额
     * @param tenantId 租户ID
     */
    void resetQuota(Long tenantId);

    /**
     * 重置所有租户配额（定时任务调用）
     */
    void resetAllQuotas();
}
