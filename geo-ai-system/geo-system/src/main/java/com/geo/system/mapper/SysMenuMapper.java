package com.geo.system.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.geo.system.entity.SysMenu;
import org.apache.ibatis.annotations.Mapper;
import java.util.List;

/**
 * 菜单数据访问接口
 */
@Mapper
public interface SysMenuMapper extends BaseMapper<SysMenu> {

    /**
     * 查询角色的所有菜单权限
     */
    List<SysMenu> findByRoleId(Long roleId);

    /**
     * 查询角色的菜单树（按父菜单ID）
     */
    List<SysMenu> findByRoleIdAndParentId(Long roleId, Long parentId);

    /**
     * 按权限代码查询
     */
    List<SysMenu> findByPermissionCode(String permissionCode);
}
