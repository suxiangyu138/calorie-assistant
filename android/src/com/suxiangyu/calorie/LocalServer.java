package com.suxiangyu.calorie;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class LocalServer {

    private static final String API_HOST = "https://api.deepseek.com";
    private static final int PORT = 17890;

    private final Context context;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private ServerSocket serverSocket;
    private volatile boolean running;
    private int port;

    public LocalServer(Context context) {
        this.context = context.getApplicationContext();
    }

    public int getPort() {
        return port;
    }

    public void start() {
        IOException failure = null;
        for (int attempt = 0; attempt < 20; attempt++) {
            try {
                serverSocket = new ServerSocket();
                serverSocket.setReuseAddress(true);
                serverSocket.bind(new java.net.InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 50);
                port = PORT;
                running = true;
                break;
            } catch (IOException e) {
                failure = e;
                try {
                    Thread.sleep(100);
                } catch (InterruptedException ignored) {
                }
            }
        }
        if (!running) {
            throw new IllegalStateException("local server start failed", failure);
        }
        Thread thread = new Thread(() -> {
            while (running) {
                try {
                    Socket client = serverSocket.accept();
                    pool.execute(() -> handle(client));
                } catch (IOException e) {
                    if (!running) break;
                }
            }
        }, "local-server");
        thread.setDaemon(true);
        thread.start();
    }

    public void stop() {
        running = false;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) {
        }
        pool.shutdownNow();
    }

    private void handle(Socket client) {
        try (Socket socket = client) {
            socket.setSoTimeout(180000);
            InputStream in = socket.getInputStream();
            OutputStream out = socket.getOutputStream();
            String head = readHead(in);
            if (head == null || head.isEmpty()) return;
            String[] lines = head.split("\r\n");
            String[] requestLine = lines[0].split(" ");
            if (requestLine.length < 2) return;
            String method = requestLine[0];
            String path = requestLine[1];
            int query = path.indexOf('?');
            if (query >= 0) path = path.substring(0, query);
            Map<String, String> headers = new HashMap<>();
            for (int i = 1; i < lines.length; i++) {
                int colon = lines[i].indexOf(':');
                if (colon > 0) {
                    headers.put(lines[i].substring(0, colon).trim().toLowerCase(Locale.ROOT), lines[i].substring(colon + 1).trim());
                }
            }
            int length = 0;
            try {
                length = Integer.parseInt(headers.getOrDefault("content-length", "0").trim());
            } catch (NumberFormatException ignored) {
            }
            byte[] body = readBody(in, length);
            if (path.startsWith("/api/")) {
                handleApi(out, method, path, headers, body);
            } else {
                serveAsset(out, path);
            }
        } catch (Exception ignored) {
        }
    }

    private String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int a = -1, b = -1, c = -1, d = -1;
        while (true) {
            int value = in.read();
            if (value < 0) break;
            buffer.write(value);
            a = b;
            b = c;
            c = d;
            d = value;
            if (a == '\r' && b == '\n' && c == '\r' && d == '\n') break;
            if (buffer.size() > 65536) break;
        }
        return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
    }

    private byte[] readBody(InputStream in, int length) throws IOException {
        if (length <= 0) return new byte[0];
        byte[] data = new byte[length];
        int offset = 0;
        while (offset < length) {
            int read = in.read(data, offset, length - offset);
            if (read < 0) break;
            offset += read;
        }
        if (offset == length) return data;
        byte[] trimmed = new byte[offset];
        System.arraycopy(data, 0, trimmed, 0, offset);
        return trimmed;
    }

    private void serveAsset(OutputStream out, String path) throws IOException {
        if (path.equals("/")) path = "/index.html";
        if (path.contains("..")) {
            sendText(out, 400, "bad request");
            return;
        }
        InputStream stream;
        String servedPath = path;
        try {
            stream = context.getAssets().open("www" + path);
        } catch (IOException e) {
            try {
                stream = context.getAssets().open("www/index.html");
                servedPath = "/index.html";
            } catch (IOException missing) {
                sendText(out, 404, "not found");
                return;
            }
        }
        byte[] data = readAll(stream);
        stream.close();
        byte[] header = ("HTTP/1.1 200 OK\r\nContent-Type: " + mimeOf(servedPath)
                + "\r\nContent-Length: " + data.length
                + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n")
                .getBytes(StandardCharsets.UTF_8);
        out.write(header);
        out.write(data);
        out.flush();
    }

    private void handleApi(OutputStream out, String method, String path, Map<String, String> headers, byte[] body) throws IOException {
        try {
            if (path.equals("/api/analyze")) {
                forward(out, method, "/chat/completions", headers, body);
                return;
            }
            if (path.equals("/api/models")) {
                forward(out, method, "/models", headers, body);
                return;
            }
            if (path.equals("/api/export")) {
                handleExport(out, body);
                return;
            }
            sendJson(out, 404, "{\"ok\":false,\"error\":\"not found\"}");
        } catch (Exception e) {
            sendJson(out, 500, "{\"ok\":false,\"error\":\"" + escape(String.valueOf(e.getMessage())) + "\"}");
        }
    }

    private void forward(OutputStream out, String method, String targetPath, Map<String, String> headers, byte[] body) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(API_HOST + targetPath).openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(30000);
        conn.setReadTimeout(180000);
        conn.setRequestProperty("Content-Type", headers.getOrDefault("content-type", "application/json"));
        String auth = headers.get("authorization");
        if (auth != null) conn.setRequestProperty("Authorization", auth);
        if (!"GET".equals(method) && body.length > 0) {
            conn.setDoOutput(true);
            try (OutputStream requestBody = conn.getOutputStream()) {
                requestBody.write(body);
            }
        }
        int code = conn.getResponseCode();
        InputStream stream = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
        byte[] data = stream == null ? new byte[0] : readAll(stream);
        if (stream != null) stream.close();
        String header = "HTTP/1.1 " + code + (code == 200 ? " OK" : " Error")
                + "\r\nContent-Type: application/json\r\nContent-Length: " + data.length
                + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
        out.write(header.getBytes(StandardCharsets.UTF_8));
        out.write(data);
        out.flush();
    }

    private void handleExport(OutputStream out, byte[] body) throws Exception {
        JSONObject payload = new JSONObject(new String(body, StandardCharsets.UTF_8));
        String name = payload.optString("name", "热量记录.json");
        String content = payload.optString("content", "");
        if (content.isEmpty()) {
            sendJson(out, 400, "{\"ok\":false,\"error\":\"empty content\"}");
            return;
        }
        String saved = saveToDownloads(name, content);
        sendJson(out, 200, "{\"ok\":true,\"path\":\"" + escape(saved) + "\"}");
    }

    private String saveToDownloads(String name, String content) throws IOException {
        byte[] data = content.getBytes(StandardCharsets.UTF_8);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, "application/json");
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            Uri uri = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IOException("insert failed");
            try (OutputStream stream = context.getContentResolver().openOutputStream(uri)) {
                if (stream == null) throw new IOException("open failed");
                stream.write(data);
            }
            return "下载/" + name;
        }
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("no download dir");
        File file = new File(dir, name);
        try (FileOutputStream stream = new FileOutputStream(file)) {
            stream.write(data);
        }
        return file.getAbsolutePath();
    }

    private void sendText(OutputStream out, int code, String text) throws IOException {
        byte[] data = text.getBytes(StandardCharsets.UTF_8);
        String header = "HTTP/1.1 " + code + " Error\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: "
                + data.length + "\r\nConnection: close\r\n\r\n";
        out.write(header.getBytes(StandardCharsets.UTF_8));
        out.write(data);
        out.flush();
    }

    private void sendJson(OutputStream out, int code, String json) throws IOException {
        byte[] data = json.getBytes(StandardCharsets.UTF_8);
        String header = "HTTP/1.1 " + code + " OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: "
                + data.length + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
        out.write(header.getBytes(StandardCharsets.UTF_8));
        out.write(data);
        out.flush();
    }

    private byte[] readAll(InputStream stream) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read;
        while ((read = stream.read(chunk)) > 0) {
            buffer.write(chunk, 0, read);
        }
        return buffer.toByteArray();
    }

    private String mimeOf(String path) {
        if (path.endsWith(".html")) return "text/html; charset=utf-8";
        if (path.endsWith(".css")) return "text/css; charset=utf-8";
        if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
        if (path.endsWith(".json")) return "application/json; charset=utf-8";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
        if (path.endsWith(".webp")) return "image/webp";
        if (path.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    private String escape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ");
    }
}
