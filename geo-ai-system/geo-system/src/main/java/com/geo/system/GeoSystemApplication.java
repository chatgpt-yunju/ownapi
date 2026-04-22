package com.geo.system;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.ComponentScan;

/**
 * GEO System Application Entry Point
 */
@SpringBootApplication
@ComponentScan(basePackages = {"com.geo.common", "com.geo.system"})
public class GeoSystemApplication {
    public static void main(String[] args) {
        SpringApplication.run(GeoSystemApplication.class, args);
    }
}
