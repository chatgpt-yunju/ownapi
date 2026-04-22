package com.geo.system.controller;

import com.geo.common.llm.LLMBaseService;
import com.geo.common.llm.exception.LLMException;
import com.geo.common.model.ApiResponse;
import com.geo.system.entity.TenantLlmConfig;
import com.geo.system.llm.LLMServiceFactory;
import com.geo.system.service.TenantLlmConfigService;
import com.geo.system.util.TenantContext;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

/**
 * 租户LLM配置控制器
 * 提供LLM配置管理的REST接口
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/llm/config")
public class TenantLlmConfigController {

    @Autowired
    private TenantLlmConfigService tenantLlmConfigService;

    @Autowired
    private LLMServiceFactory llmServiceFactory;

    /**
     * 获取当前租户的LLM配置
     *
     * @return 租户LLM配置
     */
    @GetMapping
    public ApiResponse<TenantLlmConfig> getConfig() {
        try {
            Long tenantId = TenantContext.getTenantId();
            log.info("获取LLM配置: tenantId={}", tenantId);

            TenantLlmConfig config = tenantLlmConfigService.getTenantLlmConfig(tenantId);
            if (config == null) {
                return ApiResponse.error(4001, "LLM配置不存在");
            }

            return ApiResponse.success(config);
        } catch (Exception e) {
            log.error("获取LLM配置失败", e);
            return ApiResponse.error(5000, "获取LLM配置失败");
        }
    }

    /**
     * 保存或更新LLM配置
     *
     * @param config 配置信息
     * @return 操作结果
     */
    @PostMapping
    public ApiResponse<String> saveConfig(@RequestBody TenantLlmConfig config) {
        try {
            Long tenantId = TenantContext.getTenantId();
            log.info("保存LLM配置: tenantId={}, modelType={}", tenantId, config.getModelType());

            config.setTenantId(tenantId);

            // 检查是否已存在配置
            TenantLlmConfig existing = tenantLlmConfigService.getTenantLlmConfig(tenantId);
            if (existing != null) {
                config.setId(existing.getId());
                tenantLlmConfigService.updateTenantLlmConfig(config);
            } else {
                tenantLlmConfigService.saveTenantLlmConfig(config);
            }

            return ApiResponse.success("配置保存成功");
        } catch (Exception e) {
            log.error("保存LLM配置失败", e);
            return ApiResponse.error(5000, "保存LLM配置失败");
        }
    }

    /**
     * 测试LLM连接
     *
     * @param config 配置信息
     * @return 测试结果
     */
    @PostMapping("/test")
    public ApiResponse<String> testConnection(@RequestBody TenantLlmConfig config) {
        try {
            Long tenantId = TenantContext.getTenantId();
            log.info("测试LLM连接: tenantId={}, modelType={}", tenantId, config.getModelType());

            // 获取对应的LLM服务
            LLMBaseService service = llmServiceFactory.getService(config.getModelType());

            // 调用listModels验证连接
            service.listModels(tenantId);

            log.info("LLM连接测试成功: tenantId={}", tenantId);
            return ApiResponse.success("连接成功");
        } catch (LLMException e) {
            log.warn("LLM连接测试失败: {}", e.getMessage());
            return ApiResponse.error(e.getErrorCode(), e.getErrorMessage());
        } catch (Exception e) {
            log.error("LLM连接测试异常", e);
            return ApiResponse.error(5000, "连接测试失败");
        }
    }

    /**
     * 删除LLM配置
     *
     * @return 操作结果
     */
    @DeleteMapping
    public ApiResponse<String> deleteConfig() {
        try {
            Long tenantId = TenantContext.getTenantId();
            log.info("删除LLM配置: tenantId={}", tenantId);

            tenantLlmConfigService.deleteTenantLlmConfig(tenantId);

            return ApiResponse.success("配置删除成功");
        } catch (Exception e) {
            log.error("删除LLM配置失败", e);
            return ApiResponse.error(5000, "删除LLM配置失败");
        }
    }
}
