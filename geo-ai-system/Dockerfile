# Build stage
FROM maven:3.9-eclipse-temurin-17 AS builder

WORKDIR /build

# Copy pom.xml and source code
COPY pom.xml .
COPY geo-common ./geo-common
COPY geo-system ./geo-system
COPY geo-diagnosis ./geo-diagnosis
COPY geo-monitor ./geo-monitor
COPY geo-content ./geo-content
COPY geo-data ./geo-data
COPY geo-api ./geo-api

# Build the application
RUN mvn clean package -DskipTests -q

# Runtime stage
FROM eclipse-temurin:17-jdk-slim

WORKDIR /app

# Copy the built JAR from builder stage
COPY --from=builder /build/geo-system/target/geo-system-1.0.0.jar app.jar

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD java -cp app.jar org.springframework.boot.loader.JarLauncher || exit 1

# Run the application
ENTRYPOINT ["java", "-jar", "app.jar"]
