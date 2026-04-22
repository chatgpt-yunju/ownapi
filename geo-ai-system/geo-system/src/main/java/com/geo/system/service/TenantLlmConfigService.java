package com.geo.system.service;

import com.geo.system.entity.TenantLlmConfig;

import java.util.List;

/**
 * 租户LLM配置服务接口
 */
public interface TenantLlmConfigService {
    /**
     * 获取租户LLM配置
     *
     * @param tenantId 租户ID
     * @return 租户LLM配置
     */
    TenantLlmConfig getTenantLlmConfig(Long tenantId);

    /**
     * 保存租户LLM配置
     *
     * @param config 配置信息
     */
    void saveTenantLlmConfig(TenantLlmConfig config);

    /**
     * 更新租户LLM配置
     *
     * @param config 配置信息
     */
    void updateTenantLlmConfig(TenantLlmConfig config);

    /**
     * 删除租户LLM配置
     *
     * @param tenantId 租户ID
     */
    void deleteTenantLlmConfig(Long tenantId);

    /**
     * 获取所有LLM配置
     *
     * @return 配置列表
     */
    List<TenantLlmConfig> listAll();
}
