package com.geo.system.entity;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import jakarta.persistence.*;
import java.time.LocalDateTime;

/**
 * Menu Entity
 * Represents menu items and permissions
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
@Entity
@Table(name = "sys_menu", indexes = {
    @Index(name = "idx_parent_id", columnList = "parent_id"),
    @Index(name = "idx_permission_code", columnList = "permission_code"),
    @Index(name = "idx_status", columnList = "status")
})
public class SysMenu {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "menu_name", nullable = false, length = 32)
    private String menuName;

    @Column(name = "menu_url", length = 255)
    private String menuUrl;

    @Column(name = "permission_code", length = 64)
    private String permissionCode;

    @Column(name = "parent_id")
    private Long parentId;

    @Column(name = "sort")
    private Integer sort;

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
