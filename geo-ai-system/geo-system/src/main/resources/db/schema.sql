-- GEO System Database Schema
-- Character Set: utf8mb4
-- Engine: InnoDB

-- Tenant Table
CREATE TABLE IF NOT EXISTS sys_tenant (
    id BIGINT PRIMARY KEY COMMENT '租户ID',
    tenant_name VARCHAR(64) NOT NULL COMMENT '租户名称',
    tenant_code VARCHAR(32) UNIQUE NOT NULL COMMENT '租户代码',
    contact_name VARCHAR(32) COMMENT '联系人名称',
    contact_phone VARCHAR(11) COMMENT '联系电话',
    version_id BIGINT NOT NULL COMMENT '版本ID',
    expire_time DATETIME NOT NULL COMMENT '过期时间',
    status TINYINT DEFAULT 1 COMMENT '状态: 1=启用, 0=禁用',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    del_flag TINYINT DEFAULT 0 COMMENT '逻辑删除标记: 0=未删除, 1=已删除',
    INDEX idx_tenant_code (tenant_code),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='租户表';

-- Version Table
CREATE TABLE IF NOT EXISTS sys_version (
    id BIGINT PRIMARY KEY COMMENT '版本ID',
    version_name VARCHAR(32) NOT NULL COMMENT '版本名称',
    monthly_diagnosis_count INT NOT NULL COMMENT '月度诊断次数限制',
    monitor_count_limit INT NOT NULL COMMENT '监控个数限制',
    monthly_content_count INT NOT NULL COMMENT '月度创作次数限制',
    permission_list JSON COMMENT '权限列表(JSON格式)',
    status TINYINT DEFAULT 1 COMMENT '状态: 1=启用, 0=禁用',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    del_flag TINYINT DEFAULT 0 COMMENT '逻辑删除标记: 0=未删除, 1=已删除',
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='版本表';

-- User Table
CREATE TABLE IF NOT EXISTS sys_user (
    id BIGINT PRIMARY KEY COMMENT '用户ID',
    tenant_id BIGINT NOT NULL COMMENT '租户ID',
    username VARCHAR(32) UNIQUE NOT NULL COMMENT '用户名',
    password VARCHAR(128) NOT NULL COMMENT '密码(BCrypt加密)',
    phone VARCHAR(11) COMMENT '手机号',
    email VARCHAR(64) COMMENT '邮箱',
    avatar VARCHAR(255) COMMENT '头像URL',
    role_id BIGINT NOT NULL COMMENT '角色ID',
    status TINYINT DEFAULT 1 COMMENT '状态: 1=启用, 0=禁用',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    del_flag TINYINT DEFAULT 0 COMMENT '逻辑删除标记: 0=未删除, 1=已删除',
    INDEX idx_tenant_id (tenant_id),
    INDEX idx_username (username),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户表';

-- Role Table
CREATE TABLE IF NOT EXISTS sys_role (
    id BIGINT PRIMARY KEY COMMENT '角色ID',
    tenant_id BIGINT NOT NULL COMMENT '租户ID',
    role_name VARCHAR(32) NOT NULL COMMENT '角色名称',
    role_code VARCHAR(32) NOT NULL COMMENT '角色代码',
    description VARCHAR(255) COMMENT '角色描述',
    status TINYINT DEFAULT 1 COMMENT '状态: 1=启用, 0=禁用',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    del_flag TINYINT DEFAULT 0 COMMENT '逻辑删除标记: 0=未删除, 1=已删除',
    INDEX idx_tenant_id (tenant_id),
    INDEX idx_role_code (role_code),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='角色表';

-- Menu Table
CREATE TABLE IF NOT EXISTS sys_menu (
    id BIGINT PRIMARY KEY COMMENT '菜单ID',
    menu_name VARCHAR(32) NOT NULL COMMENT '菜单名称',
    menu_url VARCHAR(255) COMMENT '菜单URL',
    permission_code VARCHAR(64) COMMENT '权限代码',
    parent_id BIGINT COMMENT '父菜单ID',
    sort INT COMMENT '排序号',
    status TINYINT DEFAULT 1 COMMENT '状态: 1=启用, 0=禁用',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    del_flag TINYINT DEFAULT 0 COMMENT '逻辑删除标记: 0=未删除, 1=已删除',
    INDEX idx_parent_id (parent_id),
    INDEX idx_permission_code (permission_code),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='菜单表';

-- User Role Association Table
CREATE TABLE IF NOT EXISTS sys_user_role (
    id BIGINT PRIMARY KEY COMMENT '关联ID',
    user_id BIGINT NOT NULL COMMENT '用户ID',
    role_id BIGINT NOT NULL COMMENT '角色ID',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    UNIQUE KEY uk_user_role (user_id, role_id),
    INDEX idx_user_id (user_id),
    INDEX idx_role_id (role_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户角色关联表';

-- Tenant LLM Configuration Table
CREATE TABLE IF NOT EXISTS tenant_llm_config (
    id BIGINT PRIMARY KEY COMMENT '配置ID',
    tenant_id BIGINT NOT NULL UNIQUE COMMENT '租户ID',
    model_type VARCHAR(32) NOT NULL COMMENT '模型类型(OpenAI/Doubao/DeepSeek等)',
    base_url VARCHAR(255) NOT NULL COMMENT 'API基础URL',
    api_key VARCHAR(255) NOT NULL COMMENT 'API密钥(AES加密)',
    model_id VARCHAR(64) NOT NULL COMMENT '模型ID',
    enabled TINYINT DEFAULT 1 COMMENT '是否启用: 1=启用, 0=禁用',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    INDEX idx_tenant_id (tenant_id),
    INDEX idx_model_type (model_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='租户LLM配置表';
