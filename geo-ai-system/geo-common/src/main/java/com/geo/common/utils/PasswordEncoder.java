package com.geo.common.utils;

import lombok.extern.slf4j.Slf4j;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Component;

import java.util.regex.Pattern;

/**
 * Password Encoder Utility
 * Handles password encoding, validation, and strength checking
 */
@Slf4j
@Component
public class PasswordEncoder {

    private static final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder();

    // Password strength validation: 6-20 chars, must contain letters and digits
    private static final Pattern PASSWORD_PATTERN = Pattern.compile("^(?=.*[a-zA-Z])(?=.*\\d).{6,20}$");

    /**
     * Encode password using BCrypt
     * @param rawPassword Raw password string
     * @return Encoded password
     */
    public String encode(String rawPassword) {
        if (rawPassword == null || rawPassword.isEmpty()) {
            throw new IllegalArgumentException("Password cannot be null or empty");
        }
        return encoder.encode(rawPassword);
    }

    /**
     * Check if raw password matches encoded password
     * @param rawPassword Raw password string
     * @param encodedPassword Encoded password string
     * @return true if passwords match
     */
    public boolean matches(String rawPassword, String encodedPassword) {
        if (rawPassword == null || encodedPassword == null) {
            return false;
        }
        return encoder.matches(rawPassword, encodedPassword);
    }

    /**
     * Validate password strength
     * Requirements: 6-20 characters, must contain both letters and digits
     * @param password Password to validate
     * @return true if password meets strength requirements
     */
    public boolean validatePasswordStrength(String password) {
        if (password == null || password.isEmpty()) {
            return false;
        }
        return PASSWORD_PATTERN.matcher(password).matches();
    }

    /**
     * Get password strength validation error message
     * @param password Password to validate
     * @return Error message if invalid, null if valid
     */
    public String getPasswordValidationError(String password) {
        if (password == null || password.isEmpty()) {
            return "密码不能为空";
        }

        if (password.length() < 6) {
            return "密码长度不能少于6位";
        }

        if (password.length() > 20) {
            return "密码长度不能超过20位";
        }

        if (!password.matches(".*[a-zA-Z].*")) {
            return "密码必须包含字母";
        }

        if (!password.matches(".*\\d.*")) {
            return "密码必须包含数字";
        }

        return null;
    }
}
