package com.geo.common.utils;

import io.jsonwebtoken.*;
import io.jsonwebtoken.security.Keys;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Component;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.TimeUnit;

/**
 * JWT Token Provider
 * Handles JWT token generation, validation, and claims extraction
 */
@Slf4j
@Component
public class JwtTokenProvider {

    @Value("${jwt.secret:your-secret-key-change-in-production-environment}")
    private String jwtSecret;

    @Value("${jwt.expiration:7200000}")
    private long jwtExpiration; // 2 hours in milliseconds

    @Value("${jwt.refresh-expiration:604800000}")
    private long refreshTokenExpiration; // 7 days in milliseconds

    private final RedisTemplate<String, String> redisTemplate;

    public JwtTokenProvider(RedisTemplate<String, String> redisTemplate) {
        this.redisTemplate = redisTemplate;
    }

    /**
     * Generate JWT access token
     * @param userId User ID
     * @param tenantId Tenant ID
     * @param roles User roles
     * @return JWT token string
     */
    public String generateToken(Long userId, Long tenantId, List<String> roles) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("userId", userId);
        claims.put("tenantId", tenantId);
        claims.put("roles", roles);
        return createToken(claims, jwtExpiration);
    }

    /**
     * Generate refresh token
     * @param userId User ID
     * @param tenantId Tenant ID
     * @return Refresh token string
     */
    public String generateRefreshToken(Long userId, Long tenantId) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("userId", userId);
        claims.put("tenantId", tenantId);
        claims.put("type", "refresh");
        return createToken(claims, refreshTokenExpiration);
    }

    /**
     * Create JWT token with claims and expiration
     * @param claims Token claims
     * @param expirationTime Expiration time in milliseconds
     * @return JWT token string
     */
    private String createToken(Map<String, Object> claims, long expirationTime) {
        Date now = new Date();
        Date expiryDate = new Date(now.getTime() + expirationTime);

        SecretKey key = Keys.hmacShaKeyFor(jwtSecret.getBytes(StandardCharsets.UTF_8));

        return Jwts.builder()
                .claims(claims)
                .issuedAt(now)
                .expiration(expiryDate)
                .signWith(key, SignatureAlgorithm.HS256)
                .compact();
    }

    /**
     * Validate JWT token
     * @param token JWT token string
     * @return true if token is valid and not blacklisted
     */
    public boolean validateToken(String token) {
        try {
            // Check if token is blacklisted
            if (isTokenBlacklisted(token)) {
                log.warn("Token is blacklisted");
                return false;
            }

            SecretKey key = Keys.hmacShaKeyFor(jwtSecret.getBytes(StandardCharsets.UTF_8));
            Jwts.parser()
                    .verifyWith(key)
                    .build()
                    .parseSignedClaims(token);
            return true;
        } catch (SecurityException e) {
            log.error("Invalid JWT signature: {}", e.getMessage());
        } catch (MalformedJwtException e) {
            log.error("Invalid JWT token: {}", e.getMessage());
        } catch (ExpiredJwtException e) {
            log.error("Expired JWT token: {}", e.getMessage());
        } catch (UnsupportedJwtException e) {
            log.error("Unsupported JWT token: {}", e.getMessage());
        } catch (IllegalArgumentException e) {
            log.error("JWT claims string is empty: {}", e.getMessage());
        }
        return false;
    }

    /**
     * Get claims from JWT token
     * @param token JWT token string
     * @return Claims object
     */
    public Claims getClaimsFromToken(String token) {
        try {
            SecretKey key = Keys.hmacShaKeyFor(jwtSecret.getBytes(StandardCharsets.UTF_8));
            return Jwts.parser()
                    .verifyWith(key)
                    .build()
                    .parseSignedClaims(token)
                    .getPayload();
        } catch (JwtException e) {
            log.error("Failed to get claims from token: {}", e.getMessage());
            return null;
        }
    }

    /**
     * Get user ID from token
     * @param token JWT token string
     * @return User ID
     */
    public Long getUserIdFromToken(String token) {
        Claims claims = getClaimsFromToken(token);
        if (claims != null) {
            Object userId = claims.get("userId");
            if (userId instanceof Number) {
                return ((Number) userId).longValue();
            }
        }
        return null;
    }

    /**
     * Get tenant ID from token
     * @param token JWT token string
     * @return Tenant ID
     */
    public Long getTenantIdFromToken(String token) {
        Claims claims = getClaimsFromToken(token);
        if (claims != null) {
            Object tenantId = claims.get("tenantId");
            if (tenantId instanceof Number) {
                return ((Number) tenantId).longValue();
            }
        }
        return null;
    }

    /**
     * Get roles from token
     * @param token JWT token string
     * @return List of roles
     */
    @SuppressWarnings("unchecked")
    public List<String> getRolesFromToken(String token) {
        Claims claims = getClaimsFromToken(token);
        if (claims != null) {
            Object roles = claims.get("roles");
            if (roles instanceof List) {
                return (List<String>) roles;
            }
        }
        return new ArrayList<>();
    }

    /**
     * Check if token is blacklisted in Redis
     * @param token JWT token string
     * @return true if token is blacklisted
     */
    public boolean isTokenBlacklisted(String token) {
        String tokenHash = hashToken(token);
        String blacklistKey = "token:blacklist:" + tokenHash;
        Boolean exists = redisTemplate.hasKey(blacklistKey);
        return exists != null && exists;
    }

    /**
     * Add token to Redis blacklist
     * @param token JWT token string
     */
    public void addTokenToBlacklist(String token) {
        try {
            Claims claims = getClaimsFromToken(token);
            if (claims != null && claims.getExpiration() != null) {
                long expirationTime = claims.getExpiration().getTime();
                long currentTime = System.currentTimeMillis();
                long ttl = (expirationTime - currentTime) / 1000; // Convert to seconds

                if (ttl > 0) {
                    String tokenHash = hashToken(token);
                    String blacklistKey = "token:blacklist:" + tokenHash;
                    redisTemplate.opsForValue().set(blacklistKey, "1", ttl, TimeUnit.SECONDS);
                    log.info("Token added to blacklist with TTL: {} seconds", ttl);
                }
            }
        } catch (Exception e) {
            log.error("Failed to add token to blacklist: {}", e.getMessage());
        }
    }

    /**
     * Hash token for Redis key (avoid key length issues)
     * @param token JWT token string
     * @return Hashed token
     */
    private String hashToken(String token) {
        return Integer.toHexString(token.hashCode());
    }

    /**
     * Get token expiration time
     * @param token JWT token string
     * @return Expiration time in milliseconds
     */
    public Long getTokenExpirationTime(String token) {
        Claims claims = getClaimsFromToken(token);
        if (claims != null && claims.getExpiration() != null) {
            return claims.getExpiration().getTime();
        }
        return null;
    }
}
