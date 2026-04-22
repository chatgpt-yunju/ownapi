package com.geo.system.service.impl;

import com.geo.system.dto.UserPermissionDTO;
import com.geo.system.entity.SysMenu;
import com.geo.system.entity.SysRole;
import com.geo.system.mapper.SysMenuMapper;
import com.geo.system.service.PermissionService;
import com.geo.system.service.RoleService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

/**
 * 权限管理业务实现
 */
@Service
public class PermissionServiceImpl implements PermissionService {

    @Autowired
    private RoleService roleService;

    @Autowired
    private SysMenuMapper menuMapper;

    @Override
    public UserPermissionDTO getUserPermissions(Long userId) {
        // 获取用户角色
        List<SysRole> roles = roleService.getRolesByUserId(userId);
        List<String> roleCodes = roles.stream()
                .map(SysRole::getRoleCode)
                .collect(Collectors.toList());

        // 获取用户菜单权限
        List<SysMenu> menus = getMenusByUserId(userId);
        List<UserPermissionDTO.MenuDTO> menuDTOs = convertToMenuDTOs(menus);

        // 获取用户权限代码
        List<String> permissions = getPermissionCodes(userId);

        UserPermissionDTO dto = new UserPermissionDTO();
        dto.setUserId(userId);
        dto.setRoles(roleCodes);
        dto.setMenus(menuDTOs);
        dto.setPermissions(permissions);

        return dto;
    }

    @Override
    public List<SysMenu> getMenusByUserId(Long userId) {
        List<SysRole> roles = roleService.getRolesByUserId(userId);
        List<SysMenu> allMenus = new ArrayList<>();

        for (SysRole role : roles) {
            List<SysMenu> roleMenus = menuMapper.findByRoleId(role.getId());
            allMenus.addAll(roleMenus);
        }

        return allMenus;
    }

    @Override
    public boolean hasPermission(Long userId, String permissionCode) {
        List<String> permissions = getPermissionCodes(userId);
        return permissions.contains(permissionCode);
    }

    @Override
    public List<String> getPermissionCodes(Long userId) {
        List<SysMenu> menus = getMenusByUserId(userId);
        return menus.stream()
                .filter(menu -> menu.getPermissionCode() != null)
                .map(SysMenu::getPermissionCode)
                .distinct()
                .collect(Collectors.toList());
    }

    /**
     * 将菜单列表转换为菜单DTO树
     */
    private List<UserPermissionDTO.MenuDTO> convertToMenuDTOs(List<SysMenu> menus) {
        List<UserPermissionDTO.MenuDTO> dtos = new ArrayList<>();

        for (SysMenu menu : menus) {
            if (menu.getParentId() == null || menu.getParentId() == 0) {
                UserPermissionDTO.MenuDTO dto = new UserPermissionDTO.MenuDTO();
                dto.setId(menu.getId());
                dto.setMenuName(menu.getMenuName());
                dto.setMenuUrl(menu.getMenuUrl());
                dto.setPermissionCode(menu.getPermissionCode());
                dto.setChildren(new ArrayList<>());
                dtos.add(dto);
            }
        }

        // 构建树形结构
        for (SysMenu menu : menus) {
            if (menu.getParentId() != null && menu.getParentId() != 0) {
                UserPermissionDTO.MenuDTO parentDTO = findMenuDTOById(dtos, menu.getParentId());
                if (parentDTO != null) {
                    UserPermissionDTO.MenuDTO childDTO = new UserPermissionDTO.MenuDTO();
                    childDTO.setId(menu.getId());
                    childDTO.setMenuName(menu.getMenuName());
                    childDTO.setMenuUrl(menu.getMenuUrl());
                    childDTO.setPermissionCode(menu.getPermissionCode());
                    childDTO.setChildren(new ArrayList<>());
                    parentDTO.getChildren().add(childDTO);
                }
            }
        }

        return dtos;
    }

    /**
     * 递归查找菜单DTO
     */
    private UserPermissionDTO.MenuDTO findMenuDTOById(List<UserPermissionDTO.MenuDTO> menus, Long id) {
        for (UserPermissionDTO.MenuDTO menu : menus) {
            if (menu.getId().equals(id)) {
                return menu;
            }
            UserPermissionDTO.MenuDTO found = findMenuDTOById(menu.getChildren(), id);
            if (found != null) {
                return found;
            }
        }
        return null;
    }
}
