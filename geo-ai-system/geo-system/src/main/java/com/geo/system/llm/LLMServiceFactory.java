package com.geo.system.llm;

import com.geo.common.llm.LLMBaseService;
import com.geo.common.llm.enums.LLMErrorCode;
import com.geo.common.llm.exception.LLMException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * LLM服务工厂
 * 根据模型类型动态返回对应的LLM实现
 */
@Slf4j
@Component
public class LLMServiceFactory {

    @Autowired
    private OpenAICompatibleService openAICompatibleService;

    /**
     * 获取LLM服务实现
     *
     * @param modelType 模型类型：openai, doubao, deepseek, ernie, qwen等
     * @return LLM服务实现
     * @throws LLMException 如果模型类型不支持
     */
    public LLMBaseService getService(String modelType) throws LLMException {
        if (modelType == null) {
            throw new LLMException(LLMErrorCode.INVALID_CONFIG, "模型类型不能为空");
        }

        switch (modelType.toLowerCase()) {
            case "openai":
            case "doubao":
            case "deepseek":
            case "ernie":
            case "qwen":
                // 所有支持OpenAI协议的平台都使用OpenAICompatibleService
                log.debug("返回OpenAICompatibleService: modelType={}", modelType);
                return openAICompatibleService;
            default:
                log.warn("不支持的模型类型: {}", modelType);
                throw new LLMException(LLMErrorCode.INVALID_CONFIG, "不支持的模型类型: " + modelType);
        }
    }
}
