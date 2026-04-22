package com.geo.system.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.geo.system.entity.TenantLlmConfig;
import com.geo.system.mapper.TenantLlmConfigMapper;
import com.geo.system.service.TenantLlmConfigService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * 租户LLM配置服务实现
 * 包含AES加密和Redis缓存功能
 */
@Slf4j
@Service
@Transactional
public class TenantLlmConfigServiceImpl implements TenantLlmConfigService {

    @Autowired
    private TenantLlmConfigMapper tenantLlmConfigMapper;

    @Autowired
    private RedisTemplate<String, Object> redisTemplate;

    @Value("${llm.encryption.key:0123456789abcdef0123456789abcdef}")
    private String encryptionKey;

    private static final String CACHE_KEY_PREFIX = "llm_config:";
    private static final long CACHE_TTL = 1; // 1小时
    private static final TimeUnit CACHE_TIME_UNIT = TimeUnit.HOURS;
    private static final String ALGORITHM = "AES";

    @Override
    public TenantLlmConfig getTenantLlmConfig(Long tenantId) {
        // 先从缓存获取
        String cacheKey = CACHE_KEY_PREFIX + tenantId;
        TenantLlmConfig cached = (TenantLlmConfig) redisTemplate.opsForValue().get(cacheKey);
        if (cached != null) {
            log.debug("从缓存获取LLM配置: tenantId={}", tenantId);
            return cached;
        }

        // 从数据库查询
        TenantLlmConfig config = tenantLlmConfigMapper.selectByTenantId(tenantId);
        if (config != null) {
            // 解密API密钥
            try {
                config.setApiKey(decryptApiKey(config.getApiKey()));
            } catch (Exception e) {
                log.error("解密API密钥失败: tenantId={}", tenantId, e);
                throw new RuntimeException("解密API密钥失败", e);
            }

            // 存入缓存
            redisTemplate.opsForValue().set(cacheKey, config, CACHE_TTL, CACHE_TIME_UNIT);
            log.debug("从数据库获取LLM配置并缓存: tenantId={}", tenantId);
        }

        return config;
    }

    @Override
    public void saveTenantLlmConfig(TenantLlmConfig config) {
        try {
            // 加密API密钥
            config.setApiKey(encryptApiKey(config.getApiKey()));
            tenantLlmConfigMapper.insert(config);
            log.info("保存LLM配置: tenantId={}, modelType={}", config.getTenantId(), config.getModelType());

            // 清除缓存
            clearCache(config.getTenantId());
        } catch (Exception e) {
            log.error("保存LLM配置失败: tenantId={}", config.getTenantId(), e);
            throw new RuntimeException("保存LLM配置失败", e);
        }
    }

    @Override
    public void updateTenantLlmConfig(TenantLlmConfig config) {
        try {
            // 加密API密钥
            config.setApiKey(encryptApiKey(config.getApiKey()));
            tenantLlmConfigMapper.updateById(config);
            log.info("更新LLM配置: tenantId={}, modelType={}", config.getTenantId(), config.getModelType());

            // 清除缓存
            clearCache(config.getTenantId());
        } catch (Exception e) {
            log.error("更新LLM配置失败: tenantId={}", config.getTenantId(), e);
            throw new RuntimeException("更新LLM配置失败", e);
        }
    }

    @Override
    public void deleteTenantLlmConfig(Long tenantId) {
        QueryWrapper<TenantLlmConfig> wrapper = new QueryWrapper<>();
        wrapper.eq("tenant_id", tenantId);
        tenantLlmConfigMapper.delete(wrapper);
        log.info("删除LLM配置: tenantId={}", tenantId);

        // 清除缓存
        clearCache(tenantId);
    }

    @Override
    public List<TenantLlmConfig> listAll() {
        return tenantLlmConfigMapper.selectList(null);
    }

    /**
     * 加密API密钥
     */
    private String encryptApiKey(String apiKey) throws Exception {
        Cipher cipher = Cipher.getInstance(ALGORITHM);
        SecretKeySpec keySpec = new SecretKeySpec(encryptionKey.getBytes(), 0, 16, ALGORITHM);
        cipher.init(Cipher.ENCRYPT_MODE, keySpec);
        byte[] encrypted = cipher.doFinal(apiKey.getBytes());
        return Base64.getEncoder().encodeToString(encrypted);
    }

    /**
     * 解密API密钥
     */
    private String decryptApiKey(String encryptedApiKey) throws Exception {
        Cipher cipher = Cipher.getInstance(ALGORITHM);
        SecretKeySpec keySpec = new SecretKeySpec(encryptionKey.getBytes(), 0, 16, ALGORITHM);
        cipher.init(Cipher.DECRYPT_MODE, keySpec);
        byte[] decodedKey = Base64.getDecoder().decode(encryptedApiKey);
        byte[] decrypted = cipher.doFinal(decodedKey);
        return new String(decrypted);
    }

    /**
     * 清除缓存
     */
    private void clearCache(Long tenantId) {
        String cacheKey = CACHE_KEY_PREFIX + tenantId;
        redisTemplate.delete(cacheKey);
        log.debug("清除LLM配置缓存: tenantId={}", tenantId);
    }
}
