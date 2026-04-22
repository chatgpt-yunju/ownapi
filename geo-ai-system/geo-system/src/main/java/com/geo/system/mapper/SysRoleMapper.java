package com.geo.system.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.geo.system.entity.SysRole;
import org.apache.ibatis.annotations.Mapper;
import java.util.List;

/**
 * 角色数据访问接口
 */
@Mapper
public interface SysRoleMapper extends BaseMapper<SysRole> {

    /**
     * 查询用户的所有角色
     */
    List<SysRole> findByUserId(Long userId);

    /**
     * 按角色代码查询
     */
    SysRole findByRoleCode(String roleCode);

    /**
     * 查询租户的所有角色
     */
    List<SysRole> findByTenantId(Long tenantId);
}
