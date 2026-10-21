package com.worl2d.backend.geo;

import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.GetMapping;

@RestController
@RequestMapping("/api/features")
public class SampleFeatureController {

    private final SampleFeatureService sampleFeatureService;

    public SampleFeatureController(SampleFeatureService sampleFeatureService) {
        this.sampleFeatureService = sampleFeatureService;
    }
    
    @GetMapping("/sample")
    public GeoJson.FeatureCollection sample() {
        return sampleFeatureService.getSampleFeatures();
    }
}