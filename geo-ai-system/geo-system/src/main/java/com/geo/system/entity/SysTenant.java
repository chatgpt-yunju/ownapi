package com.geo.system.entity;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import jakarta.persistence.*;
import java.time.LocalDateTime;

/**
 * Tenant Entity
 * Represents a tenant in the multi-tenant system
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
@Entity
@Table(name = "sys_tenant")
public class SysTenant {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "tenant_name", nullable = false, length = 64)
    private String tenantName;

    @Column(name = "tenant_code", nullable = false, unique = true, length = 32)
    private String tenantCode;

    @Column(name = "contact_name", length = 32)
    private String contactName;

    @Column(name = "contact_phone", length = 11)
    private String contactPhone;

    @Column(name = "version_id", nullable = false)
    private Long versionId;

    @Column(name = "expire_time", nullable = false)
    private LocalDateTime expireTime;

    @Column(name = "status", nullable = false)
    private Byte status;

    @Column(name = "create_time", nullable = false, updatable = false)
    private LocalDateTime createTime;

    @Column(name = "update_time", nullable = false)
    private LocalDateTime updateTime;

    @Column(name = "del_flag", nullable = false)
    private Byte delFlag;

    @PrePersist
    protected void onCreate() {
        createTime = LocalDateTime.now();
        updateTime = LocalDateTime.now();
        if (status == null) {
            status = 1;
        }
        if (delFlag == null) {
            delFlag = 0;
        }
    }

    @PreUpdate
    protected void onUpdate() {
        updateTime = LocalDateTime.now();
    }
}
