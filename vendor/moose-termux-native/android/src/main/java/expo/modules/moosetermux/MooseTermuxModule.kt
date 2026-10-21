package expo.modules.moosetermux

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.InetAddress
import java.net.ServerSocket
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Timer
import kotlin.concurrent.thread
import kotlin.concurrent.schedule

private const val ASSET = "moose-termux-service.mjs"
private const val PERMISSION = "com.termux.permission.RUN_COMMAND"

// Process-local, never persisted. The endpoint and callback have independent random tokens.
internal object Bootstrap {
  var socket: ServerSocket? = null
  var client: java.net.Socket? = null
  var callback: PendingIntent? = null
  var timer: Timer? = null
  var generation: String? = null
  var lastError: String? = null
  var pending = false
  @Synchronized fun stop(error: String? = null) {
    socket?.close(); socket = null
    client?.close(); client = null
    callback?.cancel(); callback = null
    timer?.cancel(); timer = null
    generation = null; pending = false
    if (error != null) lastError = error
  }
  @Synchronized fun complete(id: String?, error: String?) {
    if (id != generation) return
    lastError = error
    stop()
  }
}

class SetupResultReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val result = intent.getBundleExtra("result")
    val error = when {
      result == null -> "Termux returned no setup result."
      result.getInt("err", -1) != -1 -> "Termux could not execute setup. Check RUN_COMMAND permission and allow-external-apps in Termux."
      result.getInt("exitCode", -1) != 0 -> "Termux setup failed (${result.getInt("exitCode", -1)}). " + result.getString("stderr", "").take(512)
      else -> null
    }
    Bootstrap.complete(intent.data?.lastPathSegment, error)
  }
}

class MooseTermuxModule : Module() {
  private fun context(): Context = appContext.reactContext ?: error("Moose Android context unavailable")
  private fun asset(): ByteArray = context().assets.open(ASSET).use { stream ->
    val bytes = stream.readBytes()
    require(bytes.size <= 32 * 1024 * 1024) { "Bundled service exceeds the transfer limit" }
    bytes
  }
  private fun hash(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
  private fun token(): String = ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it.toInt() and 255) }
  private fun installed(): Boolean = try { context().packageManager.getPackageInfo("com.termux", 0); true } catch (_: PackageManager.NameNotFoundException) { false }
  private fun granted(): Boolean = context().checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED

  override fun definition() = ModuleDefinition {
    Name("MooseTermux")
    AsyncFunction("status") {
      synchronized(Bootstrap) {
        mapOf("installed" to installed(), "granted" to granted(), "assetHash" to hash(asset()), "pending" to Bootstrap.pending, "lastError" to Bootstrap.lastError)
      }
    }
    AsyncFunction("openTermux") {
      val intent = context().packageManager.getLaunchIntentForPackage("com.termux") ?: error("Termux is not installed")
      context().startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    AsyncFunction("openSettings") {
      context().startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context().packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    AsyncFunction("stopBootstrap") { synchronized(Bootstrap) { Bootstrap.stop() } }
    AsyncFunction("start") { publicKey: String ->
      require(Regex("^[0-9a-f]{64}$").matches(publicKey)) { "Expected a lowercase hexadecimal public pairing key" }
      check(installed()) { "Termux is not installed" }
      check(granted()) { "Grant Termux RUN_COMMAND permission first" }
      synchronized(Bootstrap) {
        check(!Bootstrap.pending) { "Termux setup is already pending" }
        val bytes = asset()
        val digest = hash(bytes)
        val path = "/${token()}"
        val id = token()
        val server = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"))
        server.soTimeout = 2000
        Bootstrap.socket = server
        Bootstrap.generation = id
        Bootstrap.pending = true
        Bootstrap.lastError = null
        Bootstrap.timer = Timer("moose-bootstrap-deadline", true).apply {
          schedule(600_000) { synchronized(Bootstrap) { if (Bootstrap.generation == id) Bootstrap.stop("Termux setup timed out. Check Termux configuration and retry.") } }
        }
        thread(name = "moose-bootstrap", isDaemon = true) {
          var requests = 0
          while (!server.isClosed && requests < 32) {
            try {
              server.accept().use { client ->
                requests++
                synchronized(Bootstrap) { if (Bootstrap.generation != id) { client.close(); return@thread }; Bootstrap.client = client }
                val headerDeadline = System.nanoTime() + 3_000_000_000L
                client.soTimeout = 3000
                val input = client.getInputStream()
                val header = StringBuilder()
                while (System.nanoTime() < headerDeadline && header.length < 8192 && !header.endsWith("\r\n\r\n")) {
                  val char = input.read()
                  if (char < 0) break
                  header.append(char.toChar())
                }
                val valid = header.endsWith("\r\n\r\n") && header.lineSequence().firstOrNull() == "GET $path HTTP/1.1"
                val output = client.getOutputStream()
                if (valid) {
                  output.write("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                  output.write(bytes)
                } else output.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
              }
            } catch (_: java.net.SocketTimeoutException) { /* bounded accept/read; deadline owns shutdown */ }
            catch (_: Exception) { if (server.isClosed) break }
          }
          if (!server.isClosed) synchronized(Bootstrap) { if (Bootstrap.generation == id) Bootstrap.stop("Setup transfer request limit exceeded.") }
        }
        try {
          val receiver = Intent(context(), SetupResultReceiver::class.java).setData(Uri.parse("moose-termux://setup/$id"))
          val flags = PendingIntent.FLAG_ONE_SHOT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
          val callback = PendingIntent.getBroadcast(context(), 0, receiver, flags)
          Bootstrap.callback = callback
          val script = context().assets.open("moose-termux-bootstrap.sh").bufferedReader().use { it.readText() }
          val intent = Intent("com.termux.RUN_COMMAND").setClassName("com.termux", "com.termux.app.RunCommandService")
            .putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/bash")
            .putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("-c", script, "moose-setup", "http://127.0.0.1:${server.localPort}$path", digest, publicKey))
            .putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
            .putExtra("com.termux.RUN_COMMAND_PENDING_INTENT", callback)
          check(context().startService(intent) != null) { "Termux rejected setup" }
        } catch (error: Exception) {
          Bootstrap.stop("Termux could not start setup. Check permission and allow-external-apps.")
          throw error
        }
        mapOf("assetHash" to digest)
      }
    }
  }
}
