package com.geo.system.config;

import okhttp3.ConnectionPool;
import okhttp3.OkHttpClient;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.concurrent.TimeUnit;

/**
 * LLM配置类
 * 配置HTTP客户端和其他LLM相关的Bean
 */
@Configuration
public class LLMConfig {

    /**
     * 配置OkHttpClient Bean
     * 用于调用LLM API
     */
    @Bean
    public OkHttpClient okHttpClient() {
        return new OkHttpClient.Builder()
                // 连接池配置
                .connectionPool(new ConnectionPool(100, 5, TimeUnit.MINUTES))
                // 连接超时
                .connectTimeout(10, TimeUnit.SECONDS)
                // 读超时
                .readTimeout(30, TimeUnit.SECONDS)
                // 写超时
                .writeTimeout(30, TimeUnit.SECONDS)
                // 重试
                .retryOnConnectionFailure(true)
                .build();
    }
}
