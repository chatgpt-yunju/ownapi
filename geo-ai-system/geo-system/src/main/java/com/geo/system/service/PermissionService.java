package com.geo.system.service;

import com.geo.system.dto.UserPermissionDTO;
import com.geo.system.entity.SysMenu;
import java.util.List;

/**
 * 权限管理业务接口
 */
public interface PermissionService {

    /**
     * 获取用户的完整权限信息
     */
    UserPermissionDTO getUserPermissions(Long userId);

    /**
     * 获取用户可访问的菜单
     */
    List<SysMenu> getMenusByUserId(Long userId);

    /**
     * 检查用户是否有特定权限
     */
    boolean hasPermission(Long userId, String permissionCode);

    /**
     * 获取用户的所有权限代码
     */
    List<String> getPermissionCodes(Long userId);
}
