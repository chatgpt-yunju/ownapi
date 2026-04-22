package com.geo.system.service.impl;

import com.geo.common.exception.GeoException;
import com.geo.common.utils.JwtTokenProvider;
import com.geo.common.utils.PasswordEncoder;
import com.geo.system.dto.LoginRequest;
import com.geo.system.dto.LoginResponse;
import com.geo.system.dto.RegisterRequest;
import com.geo.system.entity.SysUser;
import com.geo.system.mapper.SysUserMapper;
import com.geo.system.service.AuthService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Authentication Service Implementation
 */
@Slf4j
@Service
public class AuthServiceImpl implements AuthService {

    @Autowired
    private SysUserMapper sysUserMapper;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Autowired
    private RedisTemplate<String, String> redisTemplate;

    private static final long ACCOUNT_LOCK_DURATION = 3600; // 1 hour in seconds
    private static final int MAX_FAILED_ATTEMPTS = 5;

    @Override
    @Transactional
    public LoginResponse login(LoginRequest request) throws GeoException {
        String username = request.getUsername();
        String password = request.getPassword();

        // Find user by username (case-insensitive)
        SysUser user = sysUserMapper.findByUsername(username);

        // Check if user exists
        if (user == null) {
            log.warn("Login attempt with non-existent username: {}", username);
            throw new GeoException(401, "用户名或密码错误");
        }

        // Check if user is locked
        String lockKey = "user:lock:" + user.getId();
        Boolean isLocked = redisTemplate.hasKey(lockKey);
        if (isLocked != null && isLocked) {
            log.warn("Login attempt for locked account: {}", username);
            throw new GeoException(403, "账号已锁定，请1小时后重试");
        }

        // Check if password matches
        if (!passwordEncoder.matches(password, user.getPassword())) {
            // Increment failed attempts counter
            String failedKey = "user:failed:" + user.getId();
            Long failedCount = redisTemplate.opsForValue().increment(failedKey);

            // Set expiration for failed counter if it's the first attempt
            if (failedCount == 1) {
                redisTemplate.expire(failedKey, ACCOUNT_LOCK_DURATION, TimeUnit.SECONDS);
            }

            // Lock account if max attempts reached
            if (failedCount >= MAX_FAILED_ATTEMPTS) {
                redisTemplate.opsForValue().set(lockKey, "1", ACCOUNT_LOCK_DURATION, TimeUnit.SECONDS);
                log.warn("Account locked due to {} failed attempts: {}", MAX_FAILED_ATTEMPTS, username);
                throw new GeoException(403, "账号已锁定，请1小时后重试");
            }

            log.warn("Invalid password for user: {} (attempt {}/{})", username, failedCount, MAX_FAILED_ATTEMPTS);
            throw new GeoException(401, "用户名或密码错误");
        }

        // Clear failed attempts counter on successful login
        String failedKey = "user:failed:" + user.getId();
        redisTemplate.delete(failedKey);

        // Generate JWT tokens
        List<String> roles = new ArrayList<>();
        roles.add("user"); // Default role, will be enhanced in Phase 3

        String accessToken = jwtTokenProvider.generateToken(user.getId(), user.getTenantId(), roles);
        String refreshToken = jwtTokenProvider.generateRefreshToken(user.getId(), user.getTenantId());

        // Build response
        LoginResponse response = new LoginResponse();
        response.setAccessToken(accessToken);
        response.setRefreshToken(refreshToken);
        response.setExpiresIn(7200L); // 2 hours in seconds
        response.setTokenType("Bearer");
        response.setUserId(user.getId());
        response.setUsername(user.getUsername());
        response.setTenantId(user.getTenantId());
        response.setRoles(roles);

        log.info("User logged in successfully: {}", username);
        return response;
    }

    @Override
    @Transactional
    public void register(RegisterRequest request) throws GeoException {
        String username = request.getUsername();
        String password = request.getPassword();
        String confirmPassword = request.getConfirmPassword();
        String email = request.getEmail();
        Long tenantId = request.getTenantId();

        // Validate password strength
        validatePasswordStrength(password);

        // Check if passwords match
        if (!password.equals(confirmPassword)) {
            throw new GeoException(400, "两次输入的密码不一致");
        }

        // Check if username already exists
        long usernameCount = sysUserMapper.countByUsername(username);
        if (usernameCount > 0) {
            throw new GeoException(400, "用户名已存在");
        }

        // Check if email already exists (if provided)
        if (email != null && !email.isEmpty()) {
            long emailCount = sysUserMapper.countByEmail(email);
            if (emailCount > 0) {
                throw new GeoException(400, "邮箱已被注册");
            }
        }

        // Hash password
        String hashedPassword = passwordEncoder.encode(password);

        // Create user entity
        SysUser user = new SysUser();
        user.setUsername(username);
        user.setPassword(hashedPassword);
        user.setEmail(email);
        user.setPhone(request.getPhone());
        user.setTenantId(tenantId);
        user.setStatus((byte) 1); // Active status
        user.setDelFlag((byte) 0); // Not deleted
        user.setRoleId(1L); // Default read-only user role (will be enhanced in Phase 3)

        // Save user to database
        sysUserMapper.insert(user);

        log.info("User registered successfully: {}", username);
    }

    @Override
    public void logout(String token, Long userId) {
        try {
            // Add token to Redis blacklist
            jwtTokenProvider.addTokenToBlacklist(token);
            log.info("User logged out successfully: {}", userId);
        } catch (Exception e) {
            log.error("Error during logout for user {}: {}", userId, e.getMessage());
        }
    }

    @Override
    public LoginResponse refreshToken(String refreshToken) throws GeoException {
        // Validate refresh token
        if (!jwtTokenProvider.validateToken(refreshToken)) {
            throw new GeoException(401, "刷新令牌无效或已过期");
        }

        // Extract userId and tenantId from refresh token
        Long userId = jwtTokenProvider.getUserIdFromToken(refreshToken);
        Long tenantId = jwtTokenProvider.getTenantIdFromToken(refreshToken);

        if (userId == null || tenantId == null) {
            throw new GeoException(401, "刷新令牌格式错误");
        }

        // Get user from database to retrieve roles
        SysUser user = sysUserMapper.selectById(userId);
        if (user == null) {
            throw new GeoException(401, "用户不存在");
        }

        // Generate new access token with same claims
        List<String> roles = new ArrayList<>();
        roles.add("user"); // Default role

        String newAccessToken = jwtTokenProvider.generateToken(userId, tenantId, roles);
        String newRefreshToken = jwtTokenProvider.generateRefreshToken(userId, tenantId);

        // Build response
        LoginResponse response = new LoginResponse();
        response.setAccessToken(newAccessToken);
        response.setRefreshToken(newRefreshToken);
        response.setExpiresIn(7200L); // 2 hours in seconds
        response.setTokenType("Bearer");
        response.setUserId(user.getId());
        response.setUsername(user.getUsername());
        response.setTenantId(user.getTenantId());
        response.setRoles(roles);

        log.info("Token refreshed successfully for user: {}", userId);
        return response;
    }

    @Override
    public void validatePasswordStrength(String password) throws GeoException {
        String validationError = passwordEncoder.getPasswordValidationError(password);
        if (validationError != null) {
            throw new GeoException(400, validationError);
        }
    }
}
