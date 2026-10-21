package com.worl2d.backend.geo;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(SampleFeatureController.class)
@Import(SampleFeatureService.class)
public class SampleFeatureControllerTest {
    
    @Autowired
    private MockMvc mockMvc;

    @Test
    void 샘플_GeoJSON을_반환한다() throws Exception {
        mockMvc.perform(get("/api/features/sample"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.type").value("FeatureCollection"))
            .andExpect(jsonPath("$.features.length()").value(4))
            .andExpect(jsonPath("$.features[0].geometry.type").value("Polygon"))
            .andExpect(jsonPath("$.features[1].geometry.coordinates[0]").value(126.97795));
    }

    @Test
    void 허용된_출처에는_CORS_헤더를_붙인다() throws Exception {
        mockMvc.perform(get("/api/features/sample").header("Origin", "http://localhost:5173"))
            .andExpect(status().isOk())
            .andExpect(header().string("Access-Control-Allow-Origin", "http://localhost:5173"));
    }

    @Test
    void 허용되지_않은_출처는_거부한다() throws Exception {
        mockMvc.perform(get("/api/features/sample").header("Origin", "http://other-site.example"))
            .andExpect(status().isForbidden());
    }
}
