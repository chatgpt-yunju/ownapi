package com.geo.system.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.geo.system.entity.SysRole;
import com.geo.system.entity.SysUserRole;
import com.geo.system.mapper.SysRoleMapper;
import com.geo.system.mapper.SysUserRoleMapper;
import com.geo.system.service.RoleService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import java.util.List;

/**
 * 角色管理业务实现
 */
@Service
public class RoleServiceImpl implements RoleService {

    @Autowired
    private SysRoleMapper roleMapper;

    @Autowired
    private SysUserRoleMapper userRoleMapper;

    @Override
    public List<SysRole> getRolesByUserId(Long userId) {
        return roleMapper.findByUserId(userId);
    }

    @Override
    public void assignRoleToUser(Long userId, Long roleId) {
        SysUserRole userRole = new SysUserRole();
        userRole.setUserId(userId);
        userRole.setRoleId(roleId);
        userRoleMapper.insert(userRole);
    }

    @Override
    public void removeRoleFromUser(Long userId, Long roleId) {
        userRoleMapper.deleteByUserIdAndRoleId(userId, roleId);
    }

    @Override
    public List<SysRole> getAllRoles(Long tenantId) {
        return roleMapper.findByTenantId(tenantId);
    }

    @Override
    public SysRole getRoleByCode(String roleCode) {
        return roleMapper.findByRoleCode(roleCode);
    }
}
