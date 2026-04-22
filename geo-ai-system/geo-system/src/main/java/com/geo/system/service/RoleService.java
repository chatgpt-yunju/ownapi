package com.geo.system.service;

import com.geo.system.entity.SysRole;
import java.util.List;

/**
 * 角色管理业务接口
 */
public interface RoleService {

    /**
     * 获取用户的所有角色
     */
    List<SysRole> getRolesByUserId(Long userId);

    /**
     * 为用户分配角色
     */
    void assignRoleToUser(Long userId, Long roleId);

    /**
     * 移除用户的角色
     */
    void removeRoleFromUser(Long userId, Long roleId);

    /**
     * 获取租户的所有角色
     */
    List<SysRole> getAllRoles(Long tenantId);

    /**
     * 按代码获取角色
     */
    SysRole getRoleByCode(String roleCode);
}
