package cn.autolabel.engine;

import com.google.gson.JsonObject;

final class ApiError extends RuntimeException {
    final int status;
    final String code;
    final JsonObject details;
    ApiError(int status, String code, String message) { this(status,code,message,new JsonObject()); }
    ApiError(int status, String code, String message, JsonObject details) {
        super(message); this.status=status; this.code=code; this.details=details;
    }
    JsonObject json() { return Json.obj("code",code,"message",getMessage(),"details",details); }
}
