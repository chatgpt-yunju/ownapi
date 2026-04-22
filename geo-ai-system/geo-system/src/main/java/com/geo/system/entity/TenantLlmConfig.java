package com.geo.system.entity;

import com.baomidou.mybatisplus.annotation.TableLogic;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import jakarta.persistence.*;
import java.time.LocalDateTime;

/**
 * Tenant LLM Configuration Entity
 * Stores LLM configuration for each tenant
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
@Entity
@Table(name = "tenant_llm_config", indexes = {
    @Index(name = "idx_tenant_id", columnList = "tenant_id"),
    @Index(name = "idx_model_type", columnList = "model_type")
})
public class TenantLlmConfig {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "tenant_id", nullable = false, unique = true)
    private Long tenantId;

    @Column(name = "model_type", nullable = false, length = 32)
    private String modelType;

    @Column(name = "base_url", nullable = false, length = 255)
    private String baseUrl;

    @Column(name = "api_key", nullable = false, length = 255)
    private String apiKey;

    @Column(name = "model_id", nullable = false, length = 64)
    private String modelId;

    @Column(name = "enabled", nullable = false)
    private Byte enabled;

    @Column(name = "create_time", nullable = false, updatable = false)
    private LocalDateTime createTime;

    @Column(name = "update_time", nullable = false)
    private LocalDateTime updateTime;

    @Column(name = "del_flag", nullable = false)
    @TableLogic
    private Integer delFlag;

    @PrePersist
    protected void onCreate() {
        createTime = LocalDateTime.now();
        updateTime = LocalDateTime.now();
        delFlag = 0;
        if (enabled == null) {
            enabled = 1;
        }
    }

    @PreUpdate
    protected void onUpdate() {
        updateTime = LocalDateTime.now();
    }
}
