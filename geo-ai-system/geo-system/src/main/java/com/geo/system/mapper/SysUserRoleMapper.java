package com.geo.system.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.geo.system.entity.SysUserRole;
import org.apache.ibatis.annotations.Mapper;
import java.util.List;

/**
 * 用户角色关联数据访问接口
 */
@Mapper
public interface SysUserRoleMapper extends BaseMapper<SysUserRole> {

    /**
     * 查询用户的所有角色关联
     */
    List<SysUserRole> findByUserId(Long userId);

    /**
     * 删除用户的所有角色
     */
    void deleteByUserId(Long userId);

    /**
     * 删除用户的特定角色
     */
    void deleteByUserIdAndRoleId(Long userId, Long roleId);
}
