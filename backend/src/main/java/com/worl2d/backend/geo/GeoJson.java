package com.worl2d.backend.geo;

import java.util.List;

public class GeoJson {

    private GeoJson() {
    }

    public record FeatureCollection(String type, List<Feature> features) {
        public static FeatureCollection of(List<Feature> features) {
            return new FeatureCollection("FeatureCollection", features);
        }
    }

    public record Feature(String type, Properties properties, Geometry geometry){
        public static Feature of(Properties properties, Geometry geometry) {
            return new Feature("Feature", properties, geometry);
        }
    }

    public record Properties(String name, String kind){
    }

    public interface Geometry {
    }

    public record Point(String type, double[] coordinates) implements Geometry {
        public static Point of(double lng, double lat) {
            return new Point("Point", new double[] {lng, lat});
        }
    }

    public record Polygon(String type, double[][][]coordinates) implements Geometry {
        public static Polygon of(double[][] outerRing) {
            return new Polygon("Polygon", new double[][][] {outerRing});
        }
    } 
}
