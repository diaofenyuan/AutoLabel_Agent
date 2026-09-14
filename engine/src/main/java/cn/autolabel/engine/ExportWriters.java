package cn.autolabel.engine;

import com.google.gson.*;
import java.util.*;

/**
 * 导出格式的具体序列化实现。
 *
 * 与 {@link ExportFormats}（规范与路径模板）分开：这里只负责把内部标注结构写成某种标签文本，
 * 不关心路径布局，也不做落盘，便于新增格式时集中改动。
 */
final class ExportWriters {
    /** 一个素材在本次导出中的固定输出身份；路径与文件名都已按格式规范渲染完成。 */
    record Entry(JsonObject asset, String assetId, String name, String split, String image, String fileName, String label, int index, int classId, String className) {}

    /** YOLO 文本标签：与历史版本逐字节一致的写法，仅数值精度可配置。 */
    static String yolo(JsonObject asset, String type, Map<String, Integer> classes, int precision) {
        StringBuilder all = new StringBuilder();
        double w = Json.integer(asset, "width", 1), h = Json.integer(asset, "height", 1);
        for (JsonElement element : Json.array(asset, "annotations")) {
            JsonObject annotation = element.getAsJsonObject();
            StringBuilder line = new StringBuilder(Integer.toString(classes.get(Json.required(annotation, "classId"))));
            if (type.equals("detect") || type.equals("pose")) {
                JsonObject box = Json.object(annotation, "bbox");
                append(line, precision, (Annotations.num(box, "x") + Annotations.num(box, "width") / 2) / w,
                    (Annotations.num(box, "y") + Annotations.num(box, "height") / 2) / h,
                    Annotations.num(box, "width") / w, Annotations.num(box, "height") / h);
            }
            if (type.equals("pose")) for (JsonElement item : Json.array(annotation, "keypoints")) {
                JsonObject point = item.getAsJsonObject();
                int visibility = Json.integer(point, "visibility", 0);
                append(line, precision, visibility == 0 ? 0 : Annotations.num(point, "x") / w, visibility == 0 ? 0 : Annotations.num(point, "y") / h);
                line.append(' ').append(visibility);
            }
            if (type.equals("segment") || type.equals("obb")) for (JsonElement item : type.equals("obb") ? Annotations.obb(annotation) : Json.array(annotation, "points")) {
                JsonObject point = item.getAsJsonObject();
                append(line, precision, Annotations.num(point, "x") / w, Annotations.num(point, "y") / h);
            }
            all.append(line).append('\n');
        }
        return all.toString();
    }

    /** Pascal VOC 逐图 XML；坐标按该格式约定取整，仅 Detect 提供边界框。 */
    static String voc(Entry entry) {
        JsonObject asset = entry.asset();
        int width = Json.integer(asset, "width", 0), height = Json.integer(asset, "height", 0);
        int slash = entry.image().lastIndexOf('/');
        String folder = slash < 0 ? "" : entry.image().substring(0, slash);
        String file = slash < 0 ? entry.image() : entry.image().substring(slash + 1);
        StringBuilder xml = new StringBuilder();
        xml.append("<annotation>\n\t<folder>").append(xml(folder)).append("</folder>\n\t<filename>").append(xml(file)).append("</filename>\n\t<path>").append(xml(entry.image())).append("</path>\n");
        xml.append("\t<source>\n\t\t<database>自动标注小助手</database>\n\t</source>\n");
        xml.append("\t<size>\n\t\t<width>").append(width).append("</width>\n\t\t<height>").append(height).append("</height>\n\t\t<depth>3</depth>\n\t</size>\n\t<segmented>0</segmented>\n");
        for (JsonElement element : Json.array(asset, "annotations")) {
            JsonObject annotation = element.getAsJsonObject(), box = Json.object(annotation, "bbox");
            double x = Annotations.num(box, "x"), y = Annotations.num(box, "y");
            double boxWidth = Annotations.num(box, "width"), boxHeight = Annotations.num(box, "height");
            xml.append("\t<object>\n\t\t<name>").append(xml(entry.className())).append("</name>\n\t\t<pose>Unspecified</pose>\n\t\t<truncated>0</truncated>\n\t\t<difficult>0</difficult>\n");
            xml.append("\t\t<bndbox>\n\t\t\t<xmin>").append(clamp(Math.round(x), 0, width)).append("</xmin>\n\t\t\t<ymin>").append(clamp(Math.round(y), 0, height))
                .append("</ymin>\n\t\t\t<xmax>").append(clamp(Math.round(x + boxWidth), 0, width)).append("</xmax>\n\t\t\t<ymax>").append(clamp(Math.round(y + boxHeight), 0, height))
                .append("</ymax>\n\t\t</bndbox>\n\t</object>\n");
        }
        return xml.append("</annotation>\n").toString();
    }

    /** COCO 实例标注 JSON：一个索引文件对应一个划分，类别编号沿用 COCO 从 1 开始的约定。 */
    static String coco(JsonObject project, List<Entry> entries, Map<String, Integer> classes, int precision) {
        JsonArray definitions = Json.array(project, "classes"), keypointNames = Json.array(Json.object(project, "settings"), "keypointNames");
        boolean pose = Json.str(project, "taskType", "").equals("pose");
        JsonObject root = Json.obj("info", Json.obj("description", "由自动标注小助手导出", "version", "1.0", "date_created", Json.now()),
            "licenses", new JsonArray());
        JsonArray images = new JsonArray(), annotations = new JsonArray(), categories = new JsonArray();
        for (int index = 0; index < definitions.size(); index++) {
            JsonObject category = Json.obj("id", index + 1, "name", Json.required(definitions.get(index).getAsJsonObject(), "name"), "supercategory", "object");
            if (pose) category.add("keypoints", keypointNames.deepCopy());
            categories.add(category);
        }
        long annotationId = 0;
        for (Entry entry : entries) {
            JsonObject asset = entry.asset();
            int width = Json.integer(asset, "width", 0), height = Json.integer(asset, "height", 0);
            long imageId = entry.index();
            images.add(Json.obj("id", imageId, "file_name", entry.fileName(), "width", width, "height", height, "split", entry.split(),
                "content_hash", Json.str(asset, "contentHash", "")));
            for (JsonElement element : Json.array(asset, "annotations")) {
                JsonObject annotation = element.getAsJsonObject();
                String type = Json.str(annotation, "type", "");
                JsonObject output = Json.obj("id", ++annotationId, "image_id", imageId,
                    "category_id", classes.get(Json.required(annotation, "classId")) + 1, "iscrowd", 0);
                List<double[]> corners = new ArrayList<>();
                if (type.equals("segment")) for (JsonElement point : Json.array(annotation, "points")) corners.add(pixel(point.getAsJsonObject()));
                else if (type.equals("obb")) for (JsonElement point : Annotations.obb(annotation)) corners.add(pixel(point.getAsJsonObject()));
                else {
                    JsonObject box = Json.object(annotation, "bbox");
                    double x = Annotations.num(box, "x"), y = Annotations.num(box, "y");
                    corners.add(new double[]{x, y});
                    corners.add(new double[]{x + Annotations.num(box, "width"), y + Annotations.num(box, "height")});
                }
                double minX = corners.stream().mapToDouble(point -> point[0]).min().orElse(0), minY = corners.stream().mapToDouble(point -> point[1]).min().orElse(0);
                double maxX = corners.stream().mapToDouble(point -> point[0]).max().orElse(0), maxY = corners.stream().mapToDouble(point -> point[1]).max().orElse(0);
                JsonArray bbox = new JsonArray();
                for (double value : new double[]{minX, minY, maxX - minX, maxY - minY}) bbox.add(round(value, precision));
                output.add("bbox", bbox);
                output.addProperty("area", round((maxX - minX) * (maxY - minY), precision));
                if (type.equals("segment") || type.equals("obb")) {
                    JsonArray polygon = new JsonArray();
                    for (double[] point : corners) {
                        polygon.add(round(point[0], precision));
                        polygon.add(round(point[1], precision));
                    }
                    JsonArray segmentation = new JsonArray();
                    segmentation.add(polygon);
                    output.add("segmentation", segmentation);
                    output.addProperty("rotation", round(Json.decimal(annotation, "rotation", 0), precision));
                } else output.add("segmentation", new JsonArray());
                if (type.equals("pose")) {
                    JsonArray keypoints = new JsonArray();
                    int visible = 0;
                    for (JsonElement item : Json.array(annotation, "keypoints")) {
                        JsonObject point = item.getAsJsonObject();
                        int visibility = Json.integer(point, "visibility", 0);
                        if (visibility > 0) visible++;
                        keypoints.add(round(visibility == 0 ? 0 : Annotations.num(point, "x"), precision));
                        keypoints.add(round(visibility == 0 ? 0 : Annotations.num(point, "y"), precision));
                        keypoints.add(visibility);
                    }
                    output.add("keypoints", keypoints);
                    output.addProperty("num_keypoints", visible);
                }
                if (annotation.has("confidence")) output.add("confidence", annotation.get("confidence"));
                if (annotation.has("attributes")) output.add("attributes", annotation.get("attributes"));
                annotations.add(output);
            }
        }
        root.add("images", images);
        root.add("annotations", annotations);
        root.add("categories", categories);
        return Json.GSON.toJson(root);
    }

    /** 逐图一行（或逐目标一行）的 CSV 索引，列集合由格式规范决定。 */
    static String csv(JsonObject project, List<Entry> entries, List<String> columns, int precision, boolean bom) {
        Map<String, String> classNames = new HashMap<>();
        for (JsonElement element : Json.array(project, "classes")) classNames.put(Json.required(element.getAsJsonObject(), "id"), Json.required(element.getAsJsonObject(), "name"));
        int width = 0, height = 0;
        StringBuilder out = new StringBuilder();
        if (bom) out.append('\ufeff');
        for (int index = 0; index < columns.size(); index++) out.append(index == 0 ? "" : ",").append(cell(columns.get(index)));
        out.append("\r\n");
        for (Entry entry : entries) {
            JsonObject asset = entry.asset();
            width = Json.integer(asset, "width", 0);
            height = Json.integer(asset, "height", 0);
            JsonArray annotations = Json.array(asset, "annotations");
            if (annotations.isEmpty()) {
                out.append(row(entry, null, columns, classNames, width, height, precision)).append("\r\n");
                continue;
            }
            for (JsonElement element : annotations) out.append(row(entry, element.getAsJsonObject(), columns, classNames, width, height, precision)).append("\r\n");
        }
        return out.toString();
    }

    /** VOC 的 ImageSets 划分清单，内容为不带扩展名的图片名，保持该格式的既有约定。 */
    static String imageSets(List<Entry> entries) {
        StringBuilder out = new StringBuilder();
        for (Entry entry : entries) {
            String file = entry.fileName();
            int dot = file.lastIndexOf('.');
            out.append(dot > 0 ? file.substring(0, dot) : file).append('\n');
        }
        return out.toString();
    }

    private static String row(Entry entry, JsonObject annotation, List<String> columns, Map<String, String> classNames, int width, int height, int precision) {
        JsonObject asset = entry.asset();
        StringBuilder line = new StringBuilder();
        for (int index = 0; index < columns.size(); index++) {
            if (index > 0) line.append(',');
            line.append(cell(value(entry, annotation, columns.get(index), classNames, width, height, precision)));
        }
        return line.toString();
    }

    private static String value(Entry entry, JsonObject annotation, String column, Map<String, String> classNames, int width, int height, int precision) {
        JsonObject asset = entry.asset();
        if (annotation == null) return switch (column) {
            case "split" -> entry.split();
            case "assetId" -> entry.assetId();
            case "name" -> entry.name();
            case "image" -> entry.image();
            case "width" -> Integer.toString(Json.integer(asset, "width", 0));
            case "height" -> Integer.toString(Json.integer(asset, "height", 0));
            case "status" -> Json.str(asset, "status", "");
            case "source" -> Json.str(asset, "source", "");
            case "group" -> Exporter.group(asset);
            default -> "";
        };
        String classId = Json.str(annotation, "classId", "");
        double boxWidth = width == 0 ? 1 : width, boxHeight = height == 0 ? 1 : height;
        boolean boxed = Json.str(annotation, "type", "").equals("detect") || Json.str(annotation, "type", "").equals("pose");
        JsonObject box = Json.object(annotation, "bbox");
        List<double[]> corners = new ArrayList<>();
        if (boxed) {
            double x = Annotations.num(box, "x"), y = Annotations.num(box, "y");
            corners.add(new double[]{x, y});
            corners.add(new double[]{x + Annotations.num(box, "width"), y + Annotations.num(box, "height")});
        } else if (Json.str(annotation, "type", "").equals("segment"))
            for (JsonElement point : Json.array(annotation, "points")) corners.add(pixel(point.getAsJsonObject()));
        else if (Json.str(annotation, "type", "").equals("obb")) for (JsonElement point : Annotations.obb(annotation)) corners.add(pixel(point.getAsJsonObject()));
        return switch (column) {
            case "split" -> entry.split();
            case "assetId" -> entry.assetId();
            case "name" -> entry.name();
            case "image" -> entry.image();
            case "width" -> Integer.toString(Json.integer(asset, "width", 0));
            case "height" -> Integer.toString(Json.integer(asset, "height", 0));
            case "classId" -> classId;
            case "className" -> classNames.getOrDefault(classId, entry.className());
            case "cx" -> boxed ? number((Annotations.num(box, "x") + Annotations.num(box, "width") / 2) / boxWidth, precision) : "";
            case "cy" -> boxed ? number((Annotations.num(box, "y") + Annotations.num(box, "height") / 2) / boxHeight, precision) : "";
            case "w" -> boxed ? number(Annotations.num(box, "width") / boxWidth, precision) : "";
            case "h" -> boxed ? number(Annotations.num(box, "height") / boxHeight, precision) : "";
            case "xmin" -> corners.isEmpty() ? "" : number(corners.stream().mapToDouble(point -> point[0]).min().orElse(0), precision);
            case "ymin" -> corners.isEmpty() ? "" : number(corners.stream().mapToDouble(point -> point[1]).min().orElse(0), precision);
            case "xmax" -> corners.isEmpty() ? "" : number(corners.stream().mapToDouble(point -> point[0]).max().orElse(0), precision);
            case "ymax" -> corners.isEmpty() ? "" : number(corners.stream().mapToDouble(point -> point[1]).max().orElse(0), precision);
            case "rotation" -> Json.str(annotation, "type", "").equals("obb") ? number(Json.decimal(annotation, "rotation", 0), precision) : "";
            case "points" -> {
                JsonArray points = new JsonArray();
                for (double[] point : corners) {
                    points.add(round(point[0], precision));
                    points.add(round(point[1], precision));
                }
                yield points.isEmpty() ? "" : Json.GSON.toJson(points);
            }
            case "keypoints" -> Json.array(annotation, "keypoints").isEmpty() ? "" : Json.GSON.toJson(Json.array(annotation, "keypoints"));
            case "visibility" -> {
                List<String> values = new ArrayList<>();
                for (JsonElement item : Json.array(annotation, "keypoints")) values.add(Integer.toString(Json.integer(item.getAsJsonObject(), "visibility", 0)));
                yield String.join("|", values);
            }
            case "attributes" -> annotation.has("attributes") ? Json.GSON.toJson(annotation.get("attributes")) : "";
            case "status" -> Json.str(asset, "status", "");
            case "source" -> Json.str(asset, "source", "");
            case "group" -> Exporter.group(asset);
            default -> "";
        };
    }

    private static double[] pixel(JsonObject point) { return new double[]{Annotations.num(point, "x"), Annotations.num(point, "y")}; }

    private static void append(StringBuilder out, int precision, double... values) {
        for (double value : values) out.append(' ').append(number(value, precision));
    }

    static String number(double value, int precision) { return String.format(Locale.ROOT, "%." + precision + "f", value); }

    private static double round(double value, int precision) { return Double.parseDouble(String.format(Locale.ROOT, "%." + precision + "f", value)); }

    private static long clamp(long value, long min, long max) { return Math.min(Math.max(value, min), max); }

    /** CSV 单元格转义：包含分隔符、引号或换行时按 RFC 4180 加引号。 */
    private static String cell(String value) {
        if (value == null) return "";
        if (value.indexOf(',') < 0 && value.indexOf('"') < 0 && value.indexOf('\n') < 0 && value.indexOf('\r') < 0) return value;
        return '"' + value.replace("\"", "\"\"") + '"';
    }

    private static String xml(String value) {
        return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }
}
