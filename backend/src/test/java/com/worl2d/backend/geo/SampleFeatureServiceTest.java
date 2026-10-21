package com.worl2d.backend.geo;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

public class SampleFeatureServiceTest {
    
    private final SampleFeatureService service = new SampleFeatureService();

    @Test
    void 피처_4개를_FeatureCollection으로_반환한다() {
        GeoJson.FeatureCollection result = service.getSampleFeatures();

        assertThat(result.type()).isEqualTo("FeatureCollection");
        assertThat(result.features()).hasSize(4);
    }

    @Test
    void 폴리곤의_고리는_첫_점과_마지막_점이_같다() {
        for (GeoJson.Feature feature : service.getSampleFeatures().features()) {
            if (feature.geometry() instanceof GeoJson.Polygon polygon) {
                double[][] ring = polygon.coordinates()[0];
                assertThat(ring[0]).containsExactly(ring[ring.length - 1]);
            }
        }
    }

    @Test
    void 모든_좌표는_경도_위도_순서로_서울_범위_안에_있다(){
        for (GeoJson.Feature feature : service.getSampleFeatures().features()) {
            if (feature.geometry() instanceof GeoJson.Point point) {
                assertInSeoul(point.coordinates());
            } else if (feature.geometry() instanceof GeoJson.Polygon polygon) {
                for (double[] position : polygon.coordinates()[0]) {
                    assertInSeoul(position);
                }
            }
        }
    }

    private static void assertInSeoul(double[] position) {
        assertThat(position[0]).as("경도").isBetween(126.7, 127.2);
        assertThat(position[1]).as("위도").isBetween(37.4, 37.7);
    }
}
