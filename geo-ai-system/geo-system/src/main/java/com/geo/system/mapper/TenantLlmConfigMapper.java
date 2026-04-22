package com.geo.system.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.geo.system.entity.TenantLlmConfig;
import org.apache.ibatis.annotations.Mapper;

/**
 * 租户LLM配置Mapper
 */
@Mapper
public interface TenantLlmConfigMapper extends BaseMapper<TenantLlmConfig> {
    /**
     * 根据租户ID查询LLM配置
     *
     * @param tenantId 租户ID
     * @return 租户LLM配置
     */
    TenantLlmConfig selectByTenantId(Long tenantId);
}
