package com.geo.system.entity;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import jakarta.persistence.*;
import java.time.LocalDateTime;

/**
 * User Role Association Entity
 * Represents the many-to-many relationship between users and roles
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
@Entity
@Table(name = "sys_user_role", indexes = {
    @Index(name = "idx_user_id", columnList = "user_id"),
    @Index(name = "idx_role_id", columnList = "role_id")
},
uniqueConstraints = {
    @UniqueConstraint(name = "uk_user_role", columnNames = {"user_id", "role_id"})
})
public class SysUserRole {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "role_id", nullable = false)
    private Long roleId;

    @Column(name = "create_time", nullable = false, updatable = false)
    private LocalDateTime createTime;

    @PrePersist
    protected void onCreate() {
        createTime = LocalDateTime.now();
    }
}
