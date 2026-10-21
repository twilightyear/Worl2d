package com.worl2d.backend.geo;

import java.util.List;

import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.GetMapping;

@RestController
@RequestMapping("/api/features")
public class SampleFeatureController {
    
    @GetMapping("/sample")
    public GeoJson.FeatureCollection sample() {
        return GeoJson.FeatureCollection.of(List.of(
            GeoJson.Feature.of(
                new GeoJson.Properties("서울광장", "area"),
                GeoJson.Polygon.of(new double[][] {
                    {126.9774, 37.5654},
                    {126.9785, 37.5654},
                    {126.9785, 37.5662},
                    {126.9774, 37.5662},
                    {126.9774, 37.5654}
                })),
            GeoJson.Feature.of(
                new GeoJson.Properties("서울특별시청", "place"),
                GeoJson.Point.of(126.97795, 37.5665)),
            GeoJson.Feature.of(
                new GeoJson.Properties("덕수궁 대한문", "place"),
                GeoJson.Point.of(126.97685, 37.5654)),
            GeoJson.Feature.of(
                new GeoJson.Properties("청계광장", "place"),
                GeoJson.Point.of(126.978, 37.569))
        ));
    }
}