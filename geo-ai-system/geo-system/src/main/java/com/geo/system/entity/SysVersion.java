package com.geo.system.entity;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import jakarta.persistence.*;
import java.time.LocalDateTime;

/**
 * Version Entity
 * Represents a subscription version with quota limits
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
@Entity
@Table(name = "sys_version")
public class SysVersion {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "version_name", nullable = false, length = 32)
    private String versionName;

    @Column(name = "monthly_diagnosis_count", nullable = false)
    private Integer monthlyDiagnosisCount;

    @Column(name = "monitor_count_limit", nullable = false)
    private Integer monitorCountLimit;

    @Column(name = "monthly_content_count", nullable = false)
    private Integer monthlyContentCount;

    @Column(name = "permission_list", columnDefinition = "JSON")
    private String permissionList;

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
