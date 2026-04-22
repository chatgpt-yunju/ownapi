package com.geo.system.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.geo.system.entity.SysVersion;
import org.apache.ibatis.annotations.Mapper;

/**
 * 版本表Mapper
 */
@Mapper
public interface SysVersionMapper extends BaseMapper<SysVersion> {

    /**
     * 按ID查询版本
     * @param id 版本ID
     * @return SysVersion
     */
    SysVersion findById(Long id);

    /**
     * 查询所有版本
     * @return 版本列表
     */
    java.util.List<SysVersion> findAll();
}
