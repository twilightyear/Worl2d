package com.worl2d.backend.health;

import java.time.Instant;

public record HealthResponse(String status, Instant timestamp) {
    
}
