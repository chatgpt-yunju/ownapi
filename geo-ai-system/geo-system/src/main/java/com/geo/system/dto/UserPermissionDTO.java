package com.geo.system.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import java.util.List;

/**
 * 用户权限DTO
 * 包含用户的完整权限信息：角色、菜单、权限代码
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class UserPermissionDTO {
    private Long userId;
    private Long tenantId;
    private List<String> roles;
    private List<MenuDTO> menus;
    private List<String> permissions;

    /**
     * 菜单DTO
     */
    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    public static class MenuDTO {
        private Long id;
        private String menuName;
        private String menuUrl;
        private String permissionCode;
        private List<MenuDTO> children;
    }
}
