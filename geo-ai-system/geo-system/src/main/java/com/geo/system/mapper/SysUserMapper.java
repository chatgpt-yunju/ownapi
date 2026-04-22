package com.geo.system.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.geo.system.entity.SysUser;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

/**
 * User Data Access Interface
 */
@Mapper
public interface SysUserMapper extends BaseMapper<SysUser> {

    /**
     * Find user by username (case-insensitive)
     */
    SysUser findByUsername(@Param("username") String username);

    /**
     * Find user by username and tenant ID
     */
    SysUser findByUsernameAndTenantId(@Param("username") String username, @Param("tenantId") Long tenantId);

    /**
     * Find user by ID and tenant ID
     */
    SysUser findByIdAndTenantId(@Param("id") Long id, @Param("tenantId") Long tenantId);

    /**
     * Check if username exists
     */
    long countByUsername(@Param("username") String username);

    /**
     * Check if email exists
     */
    long countByEmail(@Param("email") String email);
}
